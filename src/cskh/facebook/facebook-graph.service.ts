import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { GRAPH_BASE, type CskhInboxGraphPlatform } from './facebook-oauth.util';
import {
  dedupeChatMessages,
  dedupeMediaUrls,
  FB_ATTACHMENT_FIELDS,
  FB_MESSAGE_FIELDS,
  isNoiseMessageText,
  messageNeedsMediaResolve,
  normalizeFbMessage,
  pickAttachmentUrl,
} from './facebook-message.util';
import { GraphApiCoordinatorService, type GraphRequestPriority } from './graph-api-coordinator.service';
import { CskhRedisSignalsService } from '../redis/cskh-redis-signals.service';

export type FbMessage = {
  id?: string;
  message?: string;
  from?: { id?: string; name?: string };
  created_time?: string;
  sticker?: unknown;
  attachments?: {
    data?: Array<{
      id?: string;
      mime_type?: string;
      type?: string;
      url?: string;
      image_data?: { url?: string; preview_url?: string; width?: number; height?: number };
      video_data?: { url?: string; preview_url?: string };
      file_url?: string;
      payload?: {
        url?: string;
        template_type?: string;
        elements?: Array<{ image_url?: string; title?: string; subtitle?: string }>;
      };
    }>;
  };
};

export type FbConversation = {
  id: string;
  updated_time?: string;
  participants?: { data?: Array<{ id?: string; name?: string; email?: string }> };
  link?: string;
  messages?: { data?: FbMessage[]; paging?: { next?: string } };
  unread_count?: number;
};

export type TranscriptLine = {
  sender: 'Staff' | 'Customer';
  type: string;
  text: string;
  timestamp: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  attachmentUrl?: string | null;
  attachmentUrls?: string[];
};

@Injectable()
export class FacebookGraphService {
  private readonly logger = new Logger(FacebookGraphService.name);
  private readonly graphVersion = process.env.FB_GRAPH_VERSION?.trim() || 'v21.0';
  private readonly failedProfileFetches = new Map<string, number>();

  constructor(
    private readonly graphCoordinator: GraphApiCoordinatorService,
    private readonly redisSignals: CskhRedisSignalsService,
  ) {}

  async getPagePictureUrl(pageId: string, pageToken: string): Promise<string | null> {
    try {
      const pic = await this.graphRequest<{ data?: { url?: string; is_silhouette?: boolean } }>(
        `/${pageId}/picture`,
        pageToken,
        { redirect: '0', type: 'large' },
      );
      const fromEndpoint = pic?.data?.url;
      if (fromEndpoint) return fromEndpoint;

      const data = await this.graphRequest<{ picture?: { data?: { url?: string } } }>(
        `/${pageId}`,
        pageToken,
        { fields: 'picture.type(large)' },
      );
      return data?.picture?.data?.url ?? null;
    } catch (e) {
      this.logger.warn(`Page picture ${pageId}: ${(e as Error).message}`);
      return null;
    }
  }

  async graphRequest<T>(
    urlOrPath: string,
    token: string,
    params: Record<string, string | number> = {},
    options?: { priority?: GraphRequestPriority },
  ): Promise<T> {
    const priority = options?.priority ?? 'high';
    if (priority === 'low') {
      const yieldStart = Date.now();
      while (await this.redisSignals.shouldYieldGraphToInbox()) {
        if (Date.now() - yieldStart > 120_000) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    const release = await this.graphCoordinator.acquire(priority);
    try {
      return await this.graphRequestRaw<T>(urlOrPath, token, params);
    } finally {
      release();
    }
  }

  private async graphRequestRaw<T>(
    urlOrPath: string,
    token: string,
    params: Record<string, string | number> = {},
  ): Promise<T> {
    const isFullUrl = String(urlOrPath).startsWith('http');
    const url = isFullUrl
      ? urlOrPath
      : `${GRAPH_BASE}${urlOrPath.startsWith('/') ? '' : '/'}${urlOrPath}`;

    let lastError: any = null;
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await axios.get<T>(url, {
          params: isFullUrl ? undefined : { access_token: token, ...params },
          timeout: 60000,
        });
        return res.data;
      } catch (e: unknown) {
        lastError = e;
        const err = e as { response?: { status?: number; data?: { error?: { message?: string } } }; message?: string };
        const fbErr = err.response?.data?.error;
        const errMsg = fbErr?.message || err.message || 'Graph API error';
        const status = err.response?.status;

        const isRateLimit = fbErr?.message?.includes('limit') || status === 429;
        const isServerError = status ? status >= 500 : true;

        if (attempt < maxRetries && (isRateLimit || isServerError)) {
          const delay = attempt * 2000 + (isRateLimit ? 5000 : 0);
          this.logger.warn(`GraphRequest failed (attempt ${attempt}/${maxRetries}): ${errMsg}. Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw new Error(fbErr?.message || err.message || 'Graph API error');
      }
    }
    throw lastError;
  }

  async verifyPage(pageId: string, token: string) {
    return this.graphRequest<{ id: string; name: string }>(`/${pageId}`, token, {
      fields: 'id,name',
    });
  }

  async fetchConversations(
    pageId: string,
    token: string,
    maxCount: number,
    platform: CskhInboxGraphPlatform = 'messenger',
  ): Promise<FbConversation[]> {
    const convs: FbConversation[] = [];
    let nextUrl: string | null = null;
    let first = true;
    while (convs.length < maxCount) {
      type Page = { data?: FbConversation[]; paging?: { next?: string } };
      const data: Page = first
        ? await this.graphRequest<Page>(`/${pageId}/conversations`, token, {
            platform,
            fields: 'id,updated_time,participants,unread_count',
            limit: Math.min(50, maxCount - convs.length),
          })
        : await this.graphRequest<Page>(nextUrl!, token);
      first = false;
      if (Array.isArray(data.data)) convs.push(...data.data);
      nextUrl = data.paging?.next ?? null;
      if (!nextUrl || !data.data?.length) break;
    }
    return convs.slice(0, maxCount);
  }

  /**
   * Monitor: 1 Graph call / Page — lấy danh sách hội thoại kèm tin mới nhất (field expansion).
   * Nhanh hơn N+1 request (list + từng /messages).
   */
  async fetchConversationsForMonitor(
    pageId: string,
    token: string,
    maxCount: number,
    platform: CskhInboxGraphPlatform = 'messenger',
  ): Promise<FbConversation[]> {
    const convs: FbConversation[] = [];
    let nextUrl: string | null = null;
    let first = true;
    const fields =
      `id,updated_time,participants,unread_count,messages.limit(8){${FB_MESSAGE_FIELDS}}`;
    while (convs.length < maxCount) {
      type Page = { data?: FbConversation[]; paging?: { next?: string } };
      const data: Page = first
        ? await this.graphRequest<Page>(`/${pageId}/conversations`, token, {
            platform,
            fields,
            limit: Math.min(50, maxCount - convs.length),
          })
        : await this.graphRequest<Page>(nextUrl!, token);
      first = false;
      if (Array.isArray(data.data)) convs.push(...data.data);
      nextUrl = data.paging?.next ?? null;
      if (!nextUrl || !data.data?.length) break;
    }
    return convs.slice(0, maxCount);
  }

  /** Audit: quét inbox theo ngày (VN UTC+7), dừng sớm khi hội thoại cũ hơn ngày chọn. */
  vietnamDayRange(dateStr: string) {
    return this.vietnamDateRange(dateStr, dateStr);
  }

  /** Khoảng ngày VN (UTC+7), inclusive. */
  vietnamDateRange(fromStr: string, toStr: string) {
    const start = new Date(`${fromStr}T00:00:00+07:00`);
    const end = new Date(`${toStr}T23:59:59.999+07:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error(`Khoảng ngày không hợp lệ: ${fromStr} → ${toStr}`);
    }
    if (start.getTime() > end.getTime()) {
      throw new Error(`Ngày bắt đầu phải trước hoặc bằng ngày kết thúc`);
    }
    return { start, end };
  }

  isWithinDay(isoTime: string | undefined, start: Date, end: Date) {
    if (!isoTime) return false;
    const t = new Date(isoTime).getTime();
    return t >= start.getTime() && t <= end.getTime();
  }

  filterMessagesByDay(messages: FbMessage[], auditDate: string) {
    return this.filterMessagesByDateRange(messages, auditDate, auditDate);
  }

  filterMessagesByDateRange(messages: FbMessage[], fromStr: string, toStr: string) {
    const { start, end } = this.vietnamDateRange(fromStr, toStr);
    return messages.filter((m) => this.isWithinDay(m.created_time, start, end));
  }

  /** Toàn bộ tin từ đầu hội thoại đến hết ngày kết thúc (23:59 VN). */
  filterMessagesUpToAuditDate(messages: FbMessage[], auditDate: string) {
    return this.filterMessagesUpToRangeEnd(messages, auditDate);
  }

  filterMessagesUpToRangeEnd(messages: FbMessage[], toStr: string) {
    const { end } = this.vietnamDateRange(toStr, toStr);
    return messages.filter((m) => {
      if (!m.created_time) return false;
      return new Date(m.created_time).getTime() <= end.getTime();
    });
  }

  private async runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>,
  ) {
    await this.runWithConcurrencyStoppable(items, concurrency, fn);
  }

  private async runWithConcurrencyStoppable<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>,
    shouldAbort?: () => boolean | Promise<boolean>,
  ): Promise<boolean> {
    if (!items.length) return false;
    let stoppedEarly = false;
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(concurrency, 1), items.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        if (shouldAbort && (await shouldAbort())) {
          stoppedEarly = true;
          return;
        }
        if (nextIndex >= items.length) return;
        const index = nextIndex++;
        await fn(items[index]);
      }
    });
    await Promise.all(workers);
    if (!stoppedEarly && shouldAbort && (await shouldAbort())) stoppedEarly = true;
    return stoppedEarly;
  }

  /** include = thêm vào danh sách; exclude = bỏ qua; stop = dừng quét page. */
  async fetchConversationsForAuditByDate(
    pageId: string,
    token: string,
    auditDateFrom: string,
    auditDateTo?: string,
    msgLimit = 300,
    onProgress?: (scanned: number, matched: number) => void | Promise<void>,
    fetchConcurrency = 6,
    shouldAbort?: () => boolean | Promise<boolean>,
    convFilter?: (conv: FbConversation) => 'include' | 'exclude' | 'stop',
    /** Dừng quét inbox khi đủ số hội thoại mới cần chấm (ô Giới hạn trên FE). */
    maxNewMatches = 0,
    onMatch?: (conv: FbConversation) => void | Promise<void>,
    platform: CskhInboxGraphPlatform = 'messenger',
  ): Promise<FbConversation[]> {
    const auditDateToResolved = auditDateTo?.trim() || auditDateFrom;
    const { start, end } = this.vietnamDateRange(auditDateFrom, auditDateToResolved);
    const rangeLabel =
      auditDateFrom === auditDateToResolved
        ? auditDateFrom
        : `${auditDateFrom}→${auditDateToResolved}`;
    const matched: FbConversation[] = [];
    let scanned = 0;
    let skippedAfterDay = 0;
    let skippedNoDayMsg = 0;
    let stoppedEarly = false;
    let nextUrl: string | null = null;
    let first = true;
    const safeMsgMax = Math.min(Math.max(msgLimit, 20), 500);
    // Embed cực kỳ nhỏ chỉ lấy id và created_time để lọc nhanh các hội thoại qua date range
    // Giúp tối ưu hóa tốc độ tải trang /conversations lên gấp nhiều lần
    const embedPreview = Math.min(20, safeMsgMax);
    const fields =
      `id,updated_time,participants,messages.limit(${embedPreview}){id,created_time}`;

    this.logger.log(
      `[AuditRange] page=${pageId} range=${rangeLabel} ${start.toISOString()} → ${end.toISOString()} (VN +7)`,
    );

    while (true) {
      if (shouldAbort && (await shouldAbort())) {
        this.logger.log(`[AuditRange] pause — dừng quét page=${pageId} range=${rangeLabel}`);
        this.logAuditDateSummary(rangeLabel, pageId, {
          scanned,
          matched: matched.length,
          skippedAfterDay,
          skippedNoDayMsg,
          stoppedEarly: true,
        });
        return matched;
      }

      type Page = { data?: FbConversation[]; paging?: { next?: string } };
      const data: Page = first
        ? await this.graphRequest<Page>(`/${pageId}/conversations`, token, {
            platform,
            fields,
            limit: 50,
          }, { priority: 'low' })
        : await this.graphRequest<Page>(nextUrl!, token, {}, { priority: 'low' });
      first = false;

      const batch = data.data ?? [];
      if (!batch.length) break;

      const batchMatchedBefore = matched.length;
      type BatchCandidate = { conv: FbConversation; allMsgs: FbMessage[]; needsFetch: boolean };
      const candidates: BatchCandidate[] = [];

      for (const conv of batch) {
        if (shouldAbort && (await shouldAbort())) {
          stoppedEarly = true;
          this.logAuditDateSummary(rangeLabel, pageId, {
            scanned,
            matched: matched.length,
            skippedAfterDay,
            skippedNoDayMsg,
            stoppedEarly: true,
          });
          return matched;
        }
        scanned++;
        const updatedMs = conv.updated_time ? new Date(conv.updated_time).getTime() : 0;

        if (updatedMs < start.getTime()) {
          stoppedEarly = true;
          this.logger.log(
            `[AuditRange] dừng sớm tại conv #${scanned}: updated_time=${conv.updated_time} < ${start.toISOString()}`,
          );
          if (onProgress) await onProgress(scanned, matched.length);
          this.logAuditDateSummary(rangeLabel, pageId, {
            scanned,
            matched: matched.length,
            skippedAfterDay,
            skippedNoDayMsg,
            stoppedEarly,
          });
          return matched;
        }

        const rawMsgs = conv.messages?.data ?? [];
        const dayMsgsInEmbed = this.filterMessagesByDateRange(
          rawMsgs,
          auditDateFrom,
          auditDateToResolved,
        );

        if (updatedMs > end.getTime()) {
          if (dayMsgsInEmbed.length === 0) {
            skippedAfterDay++;
            continue;
          }
        } else if (dayMsgsInEmbed.length === 0) {
          // Chưa thấy tin ngày audit trong embed — vẫn thử fetch đầy đủ
        }

        // Vì embed preview chỉ lấy id và created_time để tối ưu tốc độ,
        // chúng ta bắt buộc phải fetch đầy đủ (nội dung, người gửi, đính kèm) cho mọi cuộc hội thoại được giữ lại
        const needsFetch = true;
        candidates.push({ conv, allMsgs: rawMsgs, needsFetch });
      }

      const pendingFetches = candidates.flatMap((c, index) =>
        c.needsFetch ? [{ index, conv: c.conv }] : [],
      );

      const fetchStopped = await this.runWithConcurrencyStoppable(
        pendingFetches,
        fetchConcurrency,
        async ({ index, conv }) => {
          try {
            const fetched = await this.fetchMessagesForAuditTranscript(
              conv.id,
              token,
              auditDateFrom,
              auditDateToResolved,
              safeMsgMax,
              shouldAbort,
            );
            if (fetched.length > 0) candidates[index].allMsgs = fetched;
          } catch {
            /* giữ embed */
          }
        },
        shouldAbort,
      );
      if (fetchStopped) {
        stoppedEarly = true;
        this.logAuditDateSummary(rangeLabel, pageId, {
          scanned,
          matched: matched.length,
          skippedAfterDay,
          skippedNoDayMsg,
          stoppedEarly: true,
        });
        return matched;
      }

      for (const { conv, allMsgs, needsFetch } of candidates) {
        if (shouldAbort && (await shouldAbort())) {
          stoppedEarly = true;
          this.logAuditDateSummary(rangeLabel, pageId, {
            scanned,
            matched: matched.length,
            skippedAfterDay,
            skippedNoDayMsg,
            stoppedEarly: true,
          });
          return matched;
        }
        const transcriptMsgs = this.filterMessagesUpToRangeEnd(allMsgs, auditDateToResolved);
        const dayInTranscript = this.filterMessagesByDateRange(
          transcriptMsgs,
          auditDateFrom,
          auditDateToResolved,
        );
        if (dayInTranscript.length === 0) {
          skippedNoDayMsg++;
          continue;
        }

        if (maxNewMatches > 0 && matched.length >= maxNewMatches) {
          stoppedEarly = true;
          this.logger.log(
            `[AuditRange] đủ ${maxNewMatches} hội thoại mới — dừng quét page=${pageId} (đã lướt ${scanned} inbox)`,
          );
          if (onProgress) await onProgress(scanned, matched.length);
          this.logAuditDateSummary(rangeLabel, pageId, {
            scanned,
            matched: matched.length,
            skippedAfterDay,
            skippedNoDayMsg,
            stoppedEarly: true,
          });
          return matched;
        }

        if (convFilter) {
          const decision = convFilter(conv);
          if (decision === 'exclude') continue;
          if (decision === 'stop') {
            stoppedEarly = true;
            this.logger.log(
              `[AuditRange] dừng quét page=${pageId} range=${rangeLabel} matched=${matched.length}`,
            );
            if (onProgress) await onProgress(scanned, matched.length);
            this.logAuditDateSummary(rangeLabel, pageId, {
              scanned,
              matched: matched.length,
              skippedAfterDay,
              skippedNoDayMsg,
              stoppedEarly: true,
            });
            return matched;
          }
        }

        if (matched.length < 3) {
          this.logger.log(
            `[AuditRange] match #${matched.length + 1}: conv=${conv.id.slice(-8)} updated=${conv.updated_time} ` +
              `dayMsgs=${dayInTranscript.length} transcriptMsgs=${transcriptMsgs.length} extraFetch=${needsFetch} ` +
              `firstDay=${dayInTranscript[0]?.created_time ?? '—'} lastDay=${dayInTranscript[dayInTranscript.length - 1]?.created_time ?? '—'}`,
          );
        }

        const matchedConv = {
          ...conv,
          messages: { data: transcriptMsgs },
        };
        matched.push(matchedConv);
        if (onMatch) {
          await onMatch(matchedConv);
        }
      }

      this.logger.debug(
        `[AuditRange] batch: +${matched.length - batchMatchedBefore} match, scanned=${scanned}, totalMatch=${matched.length}`,
      );

      if (onProgress) await onProgress(scanned, matched.length);

      if (maxNewMatches > 0 && matched.length >= maxNewMatches) {
        stoppedEarly = true;
        this.logger.log(
          `[AuditRange] đủ ${maxNewMatches} hội thoại sau batch — dừng page=${pageId}`,
        );
        this.logAuditDateSummary(rangeLabel, pageId, {
          scanned,
          matched: matched.length,
          skippedAfterDay,
          skippedNoDayMsg,
          stoppedEarly: true,
        });
        return matched;
      }

      if (shouldAbort && (await shouldAbort())) {
        this.logger.log(`[AuditRange] pause — dừng sau batch page=${pageId} range=${rangeLabel}`);
        this.logAuditDateSummary(rangeLabel, pageId, {
          scanned,
          matched: matched.length,
          skippedAfterDay,
          skippedNoDayMsg,
          stoppedEarly: true,
        });
        return matched;
      }

      nextUrl = data.paging?.next ?? null;
      if (!nextUrl) break;
    }

    this.logAuditDateSummary(rangeLabel, pageId, {
      scanned,
      matched: matched.length,
      skippedAfterDay,
      skippedNoDayMsg,
      stoppedEarly,
    });
    return matched;
  }

  private logAuditDateSummary(
    auditDate: string,
    pageId: string,
    stats: {
      scanned: number;
      matched: number;
      skippedAfterDay: number;
      skippedNoDayMsg: number;
      stoppedEarly: boolean;
    },
  ) {
    this.logger.log(
      `[AuditDate] DONE page=${pageId} date=${auditDate}: ` +
        `scanned=${stats.scanned} matched=${stats.matched} ` +
        `skipAfterDay=${stats.skippedAfterDay} skipNoMsg=${stats.skippedNoDayMsg} ` +
        `stoppedEarly=${stats.stoppedEarly}`,
    );
  }

  /** @deprecated Dùng fetchConversationsForAuditByDate */
  async fetchAllConversationsForAudit(
    pageId: string,
    token: string,
    maxCount = 0,
    msgLimit = 25,
    onBatch?: (fetchedOnPage: number) => void | Promise<void>,
    shouldStop?: () => boolean,
    platform: CskhInboxGraphPlatform = 'messenger',
  ): Promise<FbConversation[]> {
  ): Promise<FbConversation[]> {
    const convs: FbConversation[] = [];
    let nextUrl: string | null = null;
    let first = true;
    const unlimited = !maxCount || maxCount <= 0;
    const safeMsgLimit = Math.min(Math.max(msgLimit, 5), 50);
    const fields =
      `id,updated_time,participants,messages.limit(${safeMsgLimit}){${FB_MESSAGE_FIELDS}}`;
    while (unlimited || convs.length < maxCount) {
      if (shouldStop?.()) break;
      type Page = { data?: FbConversation[]; paging?: { next?: string } };
      const pageLimit = unlimited ? 50 : Math.min(50, maxCount - convs.length);
      const data: Page = first
        ? await this.graphRequest<Page>(`/${pageId}/conversations`, token, {
            platform,
            fields,
            limit: pageLimit,
          }, { priority: 'low' })
        : await axios.get<Page>(nextUrl!, { timeout: 120000 }).then((r) => r.data);
      first = false;
      if (Array.isArray(data.data)) convs.push(...data.data);
      if (onBatch) await onBatch(convs.length);
      nextUrl = data.paging?.next ?? null;
      if (!nextUrl || !data.data?.length) break;
      if (!unlimited && convs.length >= maxCount) break;
    }
    return unlimited ? convs : convs.slice(0, maxCount);
  }

  /**
   * Quét backfill theo từng trang Graph — xử lý ngay, không tải hết hội thoại vào RAM trước.
   * Tránh treo UI khi page có hàng nghìn hội thoại.
   */
  async streamConversationsForBackfill(
    pageId: string,
    token: string,
    msgLimit: number,
    handlers: {
      onBatch: (convs: FbConversation[]) => Promise<'continue' | 'stop'>;
      shouldStop?: () => boolean;
    },
    platform: CskhInboxGraphPlatform = 'messenger',
  ): Promise<number> {
    let total = 0;
    let nextUrl: string | null = null;
    let first = true;
    const safeMsgLimit = Math.min(Math.max(msgLimit, 5), 50);
    const fields =
      `id,updated_time,participants,messages.limit(${safeMsgLimit}){${FB_MESSAGE_FIELDS}}`;

    while (true) {
      if (handlers.shouldStop?.()) break;
      type Page = { data?: FbConversation[]; paging?: { next?: string } };
      const data: Page = first
        ? await this.graphRequest<Page>(
            `/${pageId}/conversations`,
            token,
            { platform, fields, limit: 50 },
            { priority: 'low' },
          )
        : await this.graphRequest<Page>(nextUrl!, token, {}, { priority: 'low' });
      first = false;
      const batch = Array.isArray(data.data) ? data.data : [];
      if (!batch.length) break;
      total += batch.length;
      const action = await handlers.onBatch(batch);
      if (action === 'stop') break;
      nextUrl = data.paging?.next ?? null;
      if (!nextUrl) break;
    }
    return total;
  }

  latestMessages(conv: FbConversation): FbMessage[] {
    return conv.messages?.data ?? [];
  }

  async fetchConversationById(conversationId: string, token: string): Promise<FbConversation | null> {
    try {
      return await this.graphRequest<FbConversation>(`/${conversationId}`, token, {
        fields: 'id,updated_time,participants,unread_count',
      });
    } catch (e) {
      this.logger.warn(`fetchConversationById ${conversationId}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Tìm Facebook conversation id theo PSID khách (Page Conversations API). */
  async fetchConversationIdByPsid(
    pageId: string,
    token: string,
    participantPsid: string,
  ): Promise<string | null> {
    const psid = participantPsid.trim();
    if (!psid) return null;
    try {
      const data = await this.graphRequest<{ data?: Array<{ id?: string }> }>(
        `/${pageId}/conversations`,
        token,
        { user_id: psid, fields: 'id', limit: 1 },
      );
      return data.data?.[0]?.id ?? null;
    } catch (e) {
      this.logger.warn(
        `fetchConversationIdByPsid page=${pageId} psid=${psid.slice(0, 8)}: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Quét đầy đủ tin nhắn DỰA TRÊN tin đã tải kèm (inline) khi lấy danh sách hội thoại.
   * Tránh gọi lại Graph từ đầu cho mỗi hội thoại → nhanh hơn nhiều khi backfill.
   * Tiếp tục phân trang từ cursor `next` của inline cho đến hết.
   */
  async fetchAllMessagesFromInline(
    inline: FbMessage[] | undefined,
    nextUrl: string | null | undefined,
    token: string,
    options?: { shouldStop?: () => boolean; maxPages?: number },
  ): Promise<FbMessage[]> {
    const messages: FbMessage[] = inline ? [...inline] : [];
    let url = nextUrl ?? null;
    const maxPages = Math.max(Number(options?.maxPages ?? 40), 1);
    let pages = 0;
    while (url) {
      if (options?.shouldStop?.()) break;
      if (pages >= maxPages) break;
      type Page = { data?: FbMessage[]; paging?: { next?: string } };
      const data: Page = await this.graphRequest<Page>(url, token, {}, { priority: 'low' });
      pages++;
      if (Array.isArray(data.data)) messages.push(...data.data);
      url = data.paging?.next ?? null;
      if (!data.data?.length) break;
    }
    return messages;
  }

  /** limit <= 0 → lấy TẤT CẢ tin nhắn của hội thoại (phân trang đến hết). */
  async fetchMessages(conversationId: string, token: string, limit = 50): Promise<FbMessage[]> {
    const unlimited = !limit || limit <= 0;
    const messages: FbMessage[] = [];
    let nextUrl: string | null = null;
    let first = true;
    while (unlimited || messages.length < limit) {
      type Page = { data?: FbMessage[]; paging?: { next?: string } };
      const pageLimit = unlimited ? 50 : Math.min(50, limit - messages.length);
      const data: Page = first
        ? await this.graphRequest<Page>(`/${conversationId}/messages`, token, {
            fields: FB_MESSAGE_FIELDS,
            limit: pageLimit,
          })
        : await this.graphRequest<Page>(nextUrl!, token);
      first = false;
      if (Array.isArray(data.data)) messages.push(...data.data);
      nextUrl = data.paging?.next ?? null;
      if (!nextUrl || !data.data?.length) break;
    }
    return messages;
  }

  /**
   * Lấy tin từ đầu hội thoại đến hết ngày audit (23:59 VN).
   * Paginate Graph đến khi tin cũ nhất trước ngày audit hoặc hết trang / đạt max.
   * Trả về mới → cũ (cùng thứ tự fetchMessages) đã lọc <= cuối ngày audit.
   */
  async fetchMessagesForAuditTranscript(
    conversationId: string,
    token: string,
    auditDateFrom: string,
    auditDateTo?: string,
    maxMessages = 300,
    shouldAbort?: () => boolean | Promise<boolean>,
  ): Promise<FbMessage[]> {
    const auditDateToResolved = auditDateTo?.trim() || auditDateFrom;
    const { start, end } = this.vietnamDateRange(auditDateFrom, auditDateToResolved);
    const startMs = start.getTime();
    const endMs = end.getTime();
    const safeMax = Math.min(Math.max(maxMessages, 20), 500);
    const fetched: FbMessage[] = [];
    let nextUrl: string | null = null;
    let first = true;

    while (fetched.length < safeMax) {
      if (shouldAbort && (await shouldAbort())) break;
      type Page = { data?: FbMessage[]; paging?: { next?: string } };
      const data: Page = first
        ? await this.graphRequest<Page>(`/${conversationId}/messages`, token, {
            fields: FB_MESSAGE_FIELDS,
            limit: Math.min(25, safeMax - fetched.length),
          }, { priority: 'low' })
        : await this.graphRequest<Page>(nextUrl!, token, {}, { priority: 'low' });
      first = false;

      const batch = data.data ?? [];
      if (!batch.length) break;
      fetched.push(...batch);

      const oldest = batch[batch.length - 1];
      const oldestMs = oldest?.created_time ? new Date(oldest.created_time).getTime() : 0;
      if (oldestMs > 0 && oldestMs < startMs) break;

      nextUrl = data.paging?.next ?? null;
      if (!nextUrl) break;
    }

    return fetched.filter((m) => {
      if (!m.created_time) return false;
      return new Date(m.created_time).getTime() <= endMs;
    });
  }

  participantInfo(participants: FbConversation['participants'], pageId: string) {
    return {
      customerName: this.resolveCustomerName(participants, pageId, []),
      participantPsid: this.resolveParticipantPsid(participants, pageId),
    };
  }

  resolveParticipantPsid(participants: FbConversation['participants'], pageId: string) {
    for (const p of participants?.data ?? []) {
      if (String(p.id) !== String(pageId) && p.id) return String(p.id);
    }
    return null;
  }

  async getMessengerUserProfile(
    psid: string,
    pageToken: string,
  ): Promise<{ name: string | null; pictureUrl: string | null }> {
    // Tạm thời tắt toàn bộ cuộc gọi lấy thông tin khách hàng từ Facebook Graph API
    // để tránh bị Meta khóa API (rate limit) khi ứng dụng chưa qua Xét duyệt (App Review).
    // Khi ứng dụng đã được duyệt, bạn có thể khôi phục lại code cũ ở git history.
    return { name: null, pictureUrl: null };
  }

  async getMessengerUserName(psid: string, pageToken: string): Promise<string | null> {
    const profile = await this.getMessengerUserProfile(psid, pageToken);
    return profile.name;
  }

  /** Lọc tên khách: participants → from.name → parse từ lời NV trong chat. */
  resolveCustomerName(
    participants: FbConversation['participants'],
    pageId: string,
    messages: FbMessage[],
    transcript?: TranscriptLine[],
  ): string {
    for (const p of participants?.data ?? []) {
      if (String(p.id) !== String(pageId) && p.name?.trim()) {
        const n = this.normalizePersonName(p.name.trim());
        if (!this.isGenericCustomerName(n)) return n;
      }
    }
    for (const msg of messages) {
      const fromId = String(msg.from?.id || '');
      if (fromId !== String(pageId) && msg.from?.name?.trim()) {
        const n = this.normalizePersonName(msg.from.name.trim());
        if (!this.isGenericCustomerName(n)) return n;
      }
    }
    if (transcript?.length) {
      const parsed = this.parseNamesFromTranscript(transcript);
      if (parsed.customerName) return parsed.customerName;
    }
    return 'Khách hàng';
  }

  /** Lấy tên NV thật (không lấy nguyên tên Page/Shop). */
  resolveAgentName(
    messages: FbMessage[],
    pageId: string,
    pageName: string | null | undefined,
    transcript: TranscriptLine[],
  ): string {
    if (transcript.length) {
      const parsed = this.parseNamesFromTranscript(transcript);
      if (parsed.agentName) return parsed.agentName;
    }
    for (const msg of messages) {
      if (String(msg.from?.id || '') === String(pageId)) {
        const n = msg.from?.name?.trim();
        if (!n) continue;
        if (!this.isPageOrGenericAgent(n, pageName)) return n;
        const fromLabel = this.extractAgentFromPageLabel(n);
        if (fromLabel) return fromLabel;
      }
    }
    const fromPage = this.extractAgentFromPageLabel(pageName || '');
    if (fromPage) return fromPage;
    return 'Nhân viên';
  }

  /** VD Page "Kim Nhạn - Vân Phong Các" → NV "Kim Nhạn". */
  extractAgentFromPageLabel(label: string): string | undefined {
    const trimmed = label.trim();
    if (!trimmed) return undefined;

    const parts = trimmed.split(/\s[-–—|/]\s+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const candidate = this.normalizePersonName(parts[0]);
      if (this.isPlausibleAgentFromLabel(candidate)) return candidate;
    }
    return undefined;
  }

  private isPlausibleAgentFromLabel(name: string) {
    if (!this.isPlausiblePersonName(name)) return false;
    const n = name.toLowerCase();
    if (/(shop|store|page|official|cửa hàng|cua hang|fanpage)/i.test(n)) return false;
    if (/\bcác\b/i.test(n)) return false;
    return name.split(/\s+/).length <= 3;
  }

  parseNamesFromTranscript(transcript: TranscriptLine[]): {
    customerName?: string;
    agentName?: string;
  } {
    let customerName: string | undefined;
    let agentName: string | undefined;

    const person =
      '([a-zà-ỹA-ZÀ-Ỹ]+(?:\\s+[a-zà-ỹA-ZÀ-Ỹ]+)?)';
    const honorificName = new RegExp(
      `(?:chào|chao|dạ\\s+chào|hello|hi)\\s+(?:anh|chị|chi|em|bác|cô|chú|bạn)\\s+${person}`,
      'iu',
    );
    const vocativeName = new RegExp(
      `(?:anh|chị|chi|em|bác|cô|chú)\\s+${person}\\s*(?:ơi|oi|ạ|a|nhé|nhe|!|\\?|$)`,
      'iu',
    );
    const agentIntro = new RegExp(
      `(?:em\\s+là|tên em(?:\\s+là)?|em tên|mình là|tư vấn viên|nhân viên|tvv)\\s+${person}`,
      'iu',
    );
    const agentSign = new RegExp(
      `(?:ký tên|ky ten|trân trọng|thanks)[:\\s,]*${person}`,
      'iu',
    );
    const trailingSign = new RegExp(`[-–—]\\s*${person}\\s*$`, 'iu');
    const customerIntro = new RegExp(
      `(?:em\\s+là|tên em(?:\\s+là)?|em tên|mình là|tôi là|toi la)\\s+${person}`,
      'iu',
    );
    const customerThanksStaff = new RegExp(
      `(?:cảm ơn|cam on|thanks|thank you)\\s+(?:anh|chị|chi|em|bác|cô|chú)\\s+${person}`,
      'iu',
    );

    const pick = (raw?: string) => {
      if (!raw?.trim()) return undefined;
      const normalized = this.normalizePersonName(raw);
      return this.isPlausiblePersonName(normalized) ? normalized : undefined;
    };

    for (const line of transcript) {
      const text = (line.text || '').trim();
      if (!text) continue;

      if (line.sender === 'Staff') {
        if (!customerName) {
          const m = text.match(honorificName) || text.match(vocativeName);
          customerName = pick(m?.[1]);
        }
        if (!agentName) {
          const m = text.match(agentIntro) || text.match(agentSign) || text.match(trailingSign);
          agentName = pick(m?.[1]);
        }
      }

      if (line.sender === 'Customer') {
        if (!customerName) {
          const m = text.match(customerIntro);
          customerName = pick(m?.[1]);
        }
        if (!agentName) {
          const m = text.match(customerThanksStaff);
          agentName = pick(m?.[1]);
        }
      }
    }

    return { customerName, agentName };
  }

  private normalizePersonName(name: string) {
    return name
      .trim()
      .split(/\s+/)
      .map((part) => {
        if (!part) return part;
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      })
      .join(' ');
  }

  private isGenericCustomerName(name: string) {
    const n = name.toLowerCase().trim();
    return n === 'khách hàng' || n === 'facebook user' || n === 'người dùng facebook';
  }

  private isPageOrGenericAgent(name: string, pageName?: string | null) {
    const n = name.trim();
    if (!n || n === 'Nhân viên' || n === 'Page CSKH') return true;
    if (pageName && n.toLowerCase() === pageName.toLowerCase()) return true;
    if (/page$/i.test(n) || n.length > 40) return true;
    return false;
  }

  private isPlausiblePersonName(name: string) {
    const n = name.trim();
    if (n.length < 2 || n.length > 40) return false;
    if (/^(shop|page|facebook|khách|customer|admin)/i.test(n)) return false;
    return true;
  }

  hasStaffMessage(messages: FbMessage[], pageId: string) {
    return messages.some((m) => String(m.from?.id || '') === String(pageId));
  }

  /** Khách còn tin chưa được NV trả lời trong cùng ngày (sau lần rep cuối). */
  needsFollowUpOnDay(messages: FbMessage[], pageId: string) {
    if (!messages.length) return false;
    const ordered = [...messages].reverse();
    let lastStaffIdx = -1;
    for (let i = 0; i < ordered.length; i++) {
      if (String(ordered[i].from?.id || '') === String(pageId)) lastStaffIdx = i;
    }
    if (lastStaffIdx < 0) {
      return ordered.some((m) => String(m.from?.id || '') !== String(pageId));
    }
    let lastCustomerText = '';
    for (let i = ordered.length - 1; i > lastStaffIdx; i--) {
      if (String(ordered[i].from?.id || '') !== String(pageId)) {
        lastCustomerText = (ordered[i].message || '').trim();
        break;
      }
    }
    if (!lastCustomerText) return false;
    if (this.isClosingMessage(lastCustomerText)) return false;
    return true;
  }

  private isClosingMessage(text: string) {
    const t = text.toLowerCase().replace(/\s+/g, ' ').trim();
    return /^(ok|oke|okay|dạ|vâng|cảm ơn|cam on|thanks|thank you|nhé|nhe|hiểu rồi|đã hiểu|received)[!.?\s]*$/.test(t);
  }

  messagesToTranscript(messages: FbMessage[], pageId: string): TranscriptLine[] {
    const normalized = dedupeChatMessages(
      messages
        .slice()
        .reverse()
        .map((msg) => normalizeFbMessage(msg, pageId))
        .filter((msg): msg is NonNullable<typeof msg> => msg != null),
    );

    return normalized.map((msg) => ({
      sender: msg.sender,
      type: msg.messageType,
      text: msg.text,
      timestamp: msg.timestamp,
      attachmentUrl: msg.attachmentUrl ?? null,
      attachmentUrls: msg.attachmentUrls,
      imageUrl:
        msg.messageType === 'image'
          ? (msg.attachmentUrls?.[0] ?? msg.attachmentUrl ?? null)
          : null,
      videoUrl:
        msg.messageType === 'video'
          ? (msg.attachmentUrls?.[0] ?? msg.attachmentUrl ?? null)
          : null,
    }));
  }

  /** Lọc tin rác khi đọc từ DB (tin cũ trước khi deploy filter). */
  isStoredMessageNoise(text: string): boolean {
    return isNoiseMessageText(text);
  }

  normalizeMessageForInbox(msg: FbMessage, pageId: string, customerPsid?: string) {
    return normalizeFbMessage(msg, pageId, customerPsid);
  }

  private mediaKindFromAttachment(
    att: NonNullable<NonNullable<FbMessage['attachments']>['data']>[number] | undefined,
    url: string,
  ): 'image' | 'video' {
    if (
      att?.type === 'video' ||
      att?.mime_type?.startsWith('video/') ||
      /\.mp4(\?|$)/i.test(url)
    ) {
      return 'video';
    }
    return 'image';
  }

  private async fetchFirstAttachmentFromMessage(
    messageId: string,
    token: string,
  ): Promise<NonNullable<NonNullable<FbMessage['attachments']>['data']>[number] | null> {
    // Skip internal UUIDs — only Facebook IDs are valid for Graph API
    if (messageId.includes('-') && !messageId.startsWith('m_')) return null;
    try {
      const detail = await this.graphRequest<{ attachments?: FbMessage['attachments'] }>(
        `/${messageId}`,
        token,
        { fields: `attachments{${FB_ATTACHMENT_FIELDS}}` },
      );
      const att = detail.attachments?.data?.[0];
      if (att) return att;
    } catch (e) {
      this.logger.debug(`fetchFirstAttachmentFromMessage ${messageId}: ${(e as Error).message}`);
    }

    try {
      type Page = { data?: NonNullable<FbMessage['attachments']>['data'] };
      const edge = await this.graphRequest<Page>(`/${messageId}/attachments`, token, {
        fields: FB_ATTACHMENT_FIELDS,
      });
      return edge.data?.[0] ?? null;
    } catch (e) {
      this.logger.debug(`fetchAttachmentEdge ${messageId}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Lấy URL tất cả ảnh/video trong một tin (Facebook gửi nhiều ảnh cùng lúc). */
  async resolveAllMessageMediaUrls(
    messageId: string,
    token: string,
  ): Promise<Array<{ url: string; messageType: 'image' | 'video' }>> {
    const id = messageId.trim();
    if (!id || !token) return [];
    // Skip internal UUIDs — only Facebook message IDs (m_xxx) are valid for Graph API
    if (!id.startsWith('m_')) return [];

    try {
      const detail = await this.graphRequest<{ attachments?: FbMessage['attachments'] }>(
        `/${id}`,
        token,
        { fields: `attachments{${FB_ATTACHMENT_FIELDS}}` },
      );
      const attachments = detail.attachments?.data ?? [];
      const results: Array<{ url: string; messageType: 'image' | 'video' }> = [];
      for (const att of attachments) {
        let url = pickAttachmentUrl(att);
        if (!url && att?.id) {
          url = await this.fetchAttachmentMediaById(att.id, token);
        }
        if (url) {
          results.push({ url, messageType: this.mediaKindFromAttachment(att, url) });
        }
      }
      const deduped = dedupeMediaUrls(results.map((r) => r.url));
      if (deduped.length) {
        return deduped.map((url) => {
          const hit = results.find((r) => r.url === url || r.url.split('?')[0] === url.split('?')[0]);
          return { url, messageType: hit?.messageType ?? 'image' };
        });
      }
    } catch (e) {
      this.logger.debug(`resolveAllMessageMediaUrls ${id}: ${(e as Error).message}`);
    }

    const single = await this.resolveMessageMediaUrl(id, token);
    if (single.url) {
      return [{ url: single.url, messageType: single.messageType ?? 'image' }];
    }
    return [];
  }

  /** Lấy URL ảnh/video — fetch riêng message/attachment khi list không trả URL. */
  async resolveMessageMediaUrl(
    messageOrAttachmentId: string,
    token: string,
  ): Promise<{ url: string | null; messageType: 'image' | 'video' | null }> {
    const id = messageOrAttachmentId.trim();
    if (!id || !token) return { url: null, messageType: null };
    // Skip internal UUIDs — only Facebook IDs (m_xxx or numeric) are valid for Graph API
    if (id.includes('-') && !id.startsWith('m_')) return { url: null, messageType: null };

    const att = await this.fetchFirstAttachmentFromMessage(id, token);
    let url = pickAttachmentUrl(att ?? undefined);
    if (!url && att?.id) {
      url = await this.fetchAttachmentMediaById(att.id, token);
    }
    if (url) {
      return { url, messageType: this.mediaKindFromAttachment(att ?? undefined, url) };
    }

    try {
      const directUrl = await this.fetchAttachmentMediaById(id, token);
      if (directUrl) {
        return {
          url: directUrl,
          messageType: /\.mp4(\?|$)/i.test(directUrl) ? 'video' : 'image',
        };
      }
    } catch (e) {
      this.logger.debug(`resolveMessageMediaUrl ${id}: ${(e as Error).message}`);
    }

    return { url: null, messageType: null };
  }

  private async fetchAttachmentMediaById(
    attachmentId: string,
    token: string,
  ): Promise<string | null> {
    type AttRow = NonNullable<NonNullable<FbMessage['attachments']>['data']>[number];
    const data = await this.graphRequest<AttRow>(`/${attachmentId}`, token, {
      fields: FB_ATTACHMENT_FIELDS,
    });
    return pickAttachmentUrl(data);
  }

  async enrichMessageWithMedia(msg: FbMessage, token: string): Promise<FbMessage> {
    if (!messageNeedsMediaResolve(msg)) return msg;

    try {
      if (msg.id) {
        const detail = await this.graphRequest<{ attachments?: FbMessage['attachments'] }>(
          `/${msg.id}`,
          token,
          { fields: `attachments{${FB_ATTACHMENT_FIELDS}}` },
        );
        if (detail.attachments?.data?.length) {
          type AttRow = NonNullable<NonNullable<FbMessage['attachments']>['data']>[number];
          const enriched: AttRow[] = [];
          for (const att of detail.attachments.data) {
            if (pickAttachmentUrl(att)) {
              enriched.push(att);
              continue;
            }
            if (att?.id) {
              try {
                const full = await this.graphRequest<AttRow>(`/${att.id}`, token, {
                  fields: FB_ATTACHMENT_FIELDS,
                });
                enriched.push({ ...att, ...full });
                continue;
              } catch {
                /* thử attachment kế tiếp */
              }
            }
            enriched.push(att);
          }
          return { ...msg, attachments: { data: enriched } };
        }
      }
      const attId = msg.attachments?.data?.[0]?.id;
      if (attId) {
        type AttRow = NonNullable<NonNullable<FbMessage['attachments']>['data']>[number];
        const att = await this.graphRequest<AttRow>(`/${attId}`, token, {
          fields: FB_ATTACHMENT_FIELDS,
        });
        return {
          ...msg,
          attachments: { data: [{ ...msg.attachments!.data![0], ...att }] },
        };
      }
    } catch (e) {
      this.logger.debug(`enrichMessageWithMedia ${msg.id}: ${(e as Error).message}`);
    }
    return msg;
  }

  async enrichMessagesWithMedia(messages: FbMessage[], token: string): Promise<FbMessage[]> {
    const result: FbMessage[] = [];
    for (const msg of messages) {
      result.push(await this.enrichMessageWithMedia(msg, token));
    }
    return result;
  }

  extractAgentName(messages: FbMessage[], pageId: string, pageName?: string | null) {
    const transcript = this.messagesToTranscript(messages, pageId);
    return this.resolveAgentName(messages, pageId, pageName, transcript);
  }

  /** @deprecated Dùng needsFollowUpOnDay / hasStaffMessage */
  needsReply(messages: FbMessage[], pageId: string) {
    return this.needsFollowUpOnDay(messages, pageId);
  }

  sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async graphPost<T>(path: string, token: string, body: Record<string, unknown>): Promise<T> {
    const url = `${GRAPH_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
    try {
      const res = await axios.post<T>(url, body, {
        params: { access_token: token },
        timeout: 60000,
      });
      return res.data;
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: { message?: string } } }; message?: string };
      const fbErr = err.response?.data?.error;
      throw new Error(fbErr?.message || err.message || 'Graph API POST error');
    }
  }

  /** Gửi tin nhắn Messenger từ Page → khách (PSID). */
  async sendPageMessage(pageId: string, token: string, recipientPsid: string, text: string) {
    return this.graphPost<{ message_id?: string; recipient_id?: string }>(
      `/${pageId}/messages`,
      token,
      {
        recipient: { id: recipientPsid },
        messaging_type: 'RESPONSE',
        message: { text },
      },
    );
  }

  /** Gửi hành động sender (typing_on, typing_off, mark_seen) từ Page → khách (PSID). */
  async sendPageSenderAction(
    pageId: string,
    token: string,
    recipientPsid: string,
    senderAction: 'mark_seen' | 'typing_on' | 'typing_off',
  ) {
    return this.graphPost<{ recipient_id?: string }>(
      `/${pageId}/messages`,
      token,
      {
        recipient: { id: recipientPsid },
        sender_action: senderAction,
      },
    ).catch((e) => {
      this.logger.warn(`Failed to send sender action ${senderAction}: ${(e as Error).message}`);
      return null;
    });
  }
}
