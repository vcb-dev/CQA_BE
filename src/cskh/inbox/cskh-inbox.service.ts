import { BadRequestException, Injectable, Logger, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CskhInboxConversation, CskhInboxMessage, FacebookCskhConfig } from '@prisma/client';
import { GraphApiCoordinatorService } from '../facebook/graph-api-coordinator.service';
import {
  customerWaitingFromMessages,
  isStaffLastMessage,
  lastMessagePreviewMismatch,
} from './cskh-inbox-unread.util';
import { RedisQueueService } from '../redis/redis-queue.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../../ai/ai.service';
import { FacebookGraphService, type FbMessage, type FbConversation } from '../facebook/facebook-graph.service';
import {
  dedupeMediaUrls,
  repairStoredMessage,
  computeTrailingCustomerUnread,
  isMessengerFromCustomer,
  resolveMessengerCustomerPsid,
} from '../facebook/facebook-message.util';
import {
  detectAdFromFbMessages,
  AD_REFERRAL_ILIKE_SUBSTRINGS,
  type FbWebhookReferral,
  parseWebhookReferral,
} from '../facebook/facebook-referral.util';
import { getFacebookWebhookVerifyToken } from '../facebook/facebook-oauth.util';
import {
  CskhInboxRealtimeService,
  type CustomerIntentPayload,
  type InboxConversationPayload,
  type InboxMessagePayload,
} from './cskh-inbox-realtime.service';
import {
  capIntentMessages,
  inboxToIntentMessages,
  intentMessagesSignature,
  mergeTranscriptWithInboxTail,
} from './cskh-intent-messages.util';
import { matchInterestedProducts } from '../sapo/sapo-product-match.util';
import { SapoProductService } from '../sapo/sapo-product.service';
import { CskhInboxLabelsService, type InboxLabelDto } from './cskh-inbox-labels.service';
import { CskhService } from '../cskh.service';
import { findInboxConversationById,
  findInboxConversationByPageParticipant,
  isInboxSchemaMigrationError,
  isPrismaPoolTimeout,
} from './cskh-inbox-conversation.util';
import { getCskhRunMode, isCskhWorkerProcess } from '../cskh-run-mode';

type WebhookMessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  referral?: FbWebhookReferral;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    sticker_id?: number;
    referral?: FbWebhookReferral;
    attachments?: Array<{
      type?: string;
      payload?: { url?: string; sticker_id?: number };
    }>;
  };
};

const INBOX_MESSAGE_SELECT = {
  id: true,
  conversationId: true,
  fbMessageId: true,
  direction: true,
  senderType: true,
  text: true,
  messageType: true,
  attachmentUrl: true,
  sentAt: true,
  status: true,
} as const;

@Injectable()
export class CskhInboxService {
  private readonly logger = new Logger(CskhInboxService.name);
  private readonly syncLimit = Number(process.env.CSKH_INBOX_SYNC_LIMIT || 150);
  private readonly listSyncCooldownMs = Number(process.env.CSKH_INBOX_LIST_SYNC_COOLDOWN_MS || 60_000);
  private readonly lastListSync = new Map<string, number>();
  /** Quét luân phiên khi xem "Tất cả Page" — mỗi lần sync N page, không quét 87 page cùng lúc. */
  private readonly allPagesSyncBatch = Number(process.env.CSKH_INBOX_ALL_PAGES_SYNC_BATCH || 2);
  private readonly allPagesSyncCooldownMs = Number(
    process.env.CSKH_INBOX_ALL_PAGES_SYNC_COOLDOWN_MS || 45_000,
  );
  private allPagesSyncCursor = 0;
  private lastAllPagesRotatingSync = 0;
  /** Tắt mặc định — tránh quét inbox nền khi mở danh sách (chỉ bật khi CSKH_INBOX_ROTATING_SYNC_ENABLED=true). */
  private readonly rotatingSyncEnabled =
    process.env.CSKH_INBOX_ROTATING_SYNC_ENABLED === 'true';
  private readonly msgLimit = Number(process.env.CSKH_INBOX_MSG_LIMIT || 50);
  /** Khi recheck audit — tải nhiều tin hơn để so khớp transcript. */
  private readonly auditRecheckMsgLimit = Number(
    process.env.CSKH_INBOX_AUDIT_RECHECK_LIMIT || 200,
  );
  /** Tránh gọi Graph mỗi lần FE poll — gây nhảy UI. */
  private readonly graphRefreshCooldownMs = Number(
    process.env.CSKH_GRAPH_REFRESH_COOLDOWN_MS || 60_000,
  );
  private readonly lastGraphRefresh = new Map<string, number>();
  private readonly lastReconcileRead = new Map<string, number>();
  private readonly reconcileReadCooldownMs = 45_000;
  private readonly pendingIntentRequests = new Set<string>();
  private readonly intentCache = new Map<
    string,
    { signature: string; at: number; data: CustomerIntentPayload }
  >();
  private readonly intentCacheTtlMs = 600_000;
  private readonly configCache = new Map<string, { config: FacebookCskhConfig | null; at: number }>();
  private readonly configCacheTtlMs = 60_000;
  private readonly conversationStatsCache = new Map<
    string,
    { at: number; data: Awaited<ReturnType<CskhInboxService['getConversationStats']>> }
  >();
  private readonly conversationStatsTtlMs = Number(
    process.env.CSKH_CONVERSATION_STATS_TTL_MS || 90_000,
  );
  /** Tối đa thời gian quét 1 kênh — tránh treo vô hạn trên page lớn. */
  private readonly backfillPageTimeoutMs = Number(
    process.env.CSKH_BACKFILL_PAGE_TIMEOUT_MS || 1_200_000,
  );
  private readonly backfillConvTimeoutMs = Number(
    process.env.CSKH_BACKFILL_CONV_TIMEOUT_MS || 180_000,
  );
  private readonly backfillMsgMaxPages = Math.max(
    Number(process.env.CSKH_BACKFILL_MSG_MAX_PAGES || 40),
    5,
  );
  /** Số hội thoại tối đa trả về — 0 = không giới hạn (cẩn thận với DB lớn). */
  private readonly listConversationsLimit = Number(process.env.CSKH_INBOX_LIST_LIMIT || 50000);
  private readonly adReferralBackfillCooldownMs = Number(
    process.env.CSKH_AD_REFERRAL_BACKFILL_COOLDOWN_MS || 600_000,
  );
  private lastAdReferralBackfillAt = 0;
  private adReferralBackfillRunning = false;

  /** Trạng thái tiến trình "Quét đầy đủ" — đồng bộ với cskh_job_runs (type=inbox-backfill). */
  private backfillPauseRequested = false;
  private backfillCancelRequested = false;
  private backfillPausePoller: ReturnType<typeof setInterval> | null = null;
  private backfillJobId: string | null = null;
  private backfillTenantId: string | undefined;
  private backfillCompletedPageIds: string[] = [];
  private backfillLastProgressPersistAt = 0;
  private backfillState: {
    running: boolean;
    paused: boolean;
    scope: 'empty' | 'all' | '';
    total: number;
    done: number;
    currentPage: string | null;
    pageConvsDone: number;
    addedMessages: number;
    okPages: number;
    errorPages: Array<{ page: string; error: string; pageId?: string }>;
    startedAt: string | null;
    finishedAt: string | null;
    jobId: string | null;
  } = {
    running: false,
    paused: false,
    scope: '',
    total: 0,
    done: 0,
    currentPage: null,
    pageConvsDone: 0,
    addedMessages: 0,
    okPages: 0,
    errorPages: [],
    startedAt: null,
    finishedAt: null,
    jobId: null,
  };

  private toBackfillResponse() {
    return { ...this.backfillState };
  }

  private jobSummaryToState(summary: Record<string, unknown> | null | undefined) {
    const s = summary ?? {};
    return {
      scope: (s.scope as 'empty' | 'all') ?? '',
      total: Number(s.total ?? 0),
      done: Number(s.done ?? 0),
      currentPage: (s.currentPage as string | null) ?? null,
      pageConvsDone: Number(s.pageConvsDone ?? 0),
      addedMessages: Number(s.addedMessages ?? 0),
      okPages: Number(s.okPages ?? 0),
      errorPages: (s.errorPages as Array<{ page: string; error: string; pageId?: string }>) ?? [],
      completedPageIds: (s.completedPageIds as string[]) ?? [],
    };
  }

  private async findPausedBackfillJob(tenantId?: string) {
    const where: { type: string; status: string; tenantId?: string } = {
      type: 'inbox-backfill',
      status: 'paused',
    };
    if (tenantId) where.tenantId = tenantId;
    return this.prisma.cskhJobRun.findFirst({
      where,
      orderBy: { startedAt: 'desc' },
    });
  }

  private async findRunningBackfillJob(tenantId?: string) {
    return this.prisma.cskhJobRun.findFirst({
      where: {
        type: 'inbox-backfill',
        status: 'running',
        ...(tenantId ? { tenantId } : {}),
      },
      orderBy: { startedAt: 'desc' },
    });
  }

  private async findRecentBackfillJob(tenantId?: string) {
    return this.prisma.cskhJobRun.findFirst({
      where: {
        type: 'inbox-backfill',
        status: { in: ['completed', 'failed'] },
        finishedAt: { gte: new Date(Date.now() - 86_400_000) },
        ...(tenantId ? { tenantId } : {}),
      },
      orderBy: { finishedAt: 'desc' },
    });
  }

  private backfillStatusFromJob(
    job: {
      id: string;
      status: string;
      startedAt: Date;
      finishedAt: Date | null;
      summary: unknown;
    },
    overrides?: { running?: boolean; paused?: boolean },
  ) {
    const parsed = this.jobSummaryToState(job.summary as Record<string, unknown>);
    const summaryPaused = (job.summary as Record<string, unknown> | null)?.paused === true;
    const pauseRequested = (job.summary as Record<string, unknown> | null)?.pauseRequested === true;
    return {
      running: overrides?.running ?? job.status === 'running',
      paused: overrides?.paused ?? (job.status === 'paused' || summaryPaused),
      pauseRequested: pauseRequested && job.status === 'running',
      scope: parsed.scope,
      total: parsed.total,
      done: parsed.done,
      currentPage: parsed.currentPage,
      pageConvsDone: parsed.pageConvsDone,
      addedMessages: parsed.addedMessages,
      okPages: parsed.okPages,
      errorPages: parsed.errorPages,
      completedPageIds: parsed.completedPageIds,
      startedAt: job.startedAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
      jobId: job.id,
    };
  }

  private async buildBackfillPageList(
    scope: 'empty' | 'all',
    tenantId: string | undefined,
    completedPageIds: string[],
  ): Promise<Array<{ pageId: string; pageName: string | null }>> {
    const tenantFilter = tenantId
      ? Prisma.sql`AND cfg.tenant_id = ${tenantId}::uuid`
      : Prisma.empty;

    const allPages = await this.prisma.$queryRaw<Array<{ pageId: string; pageName: string | null }>>`
      SELECT cfg.page_id AS "pageId", cfg.page_name AS "pageName"
      FROM facebook_cskh_configs cfg
      WHERE cfg.page_access_token IS NOT NULL AND cfg.page_access_token <> ''
      ${tenantFilter}
      ORDER BY cfg.page_name ASC
    `;

    if (scope === 'empty') {
      const emptyRows = await this.prisma.$queryRaw<Array<{ pageId: string; pageName: string | null }>>`
        SELECT cfg.page_id AS "pageId", cfg.page_name AS "pageName"
        FROM facebook_cskh_configs cfg
        WHERE cfg.page_access_token IS NOT NULL AND cfg.page_access_token <> ''
        ${tenantFilter}
        AND NOT EXISTS (
          SELECT 1 FROM cskh_inbox_conversations c
          JOIN cskh_inbox_messages m ON m.conversation_id = c.id
          WHERE c.page_id = cfg.page_id
        )
        ORDER BY cfg.page_name ASC
      `;
      return emptyRows.filter((p) => !completedPageIds.includes(p.pageId));
    }

    return allPages.filter((p) => !completedPageIds.includes(p.pageId));
  }

  private startBackfillPausePoller(): void {
    this.stopBackfillPausePoller();
    this.backfillPausePoller = setInterval(() => {
      void this.isBackfillPauseRequestedNow();
    }, 1500);
  }

  private stopBackfillPausePoller(): void {
    if (this.backfillPausePoller) {
      clearInterval(this.backfillPausePoller);
      this.backfillPausePoller = null;
    }
  }

  private async markBackfillPauseRequestedInDb(jobId: string): Promise<void> {
    const job = await this.prisma.cskhJobRun.findUnique({ where: { id: jobId } });
    if (!job) return;
    const prev = (job.summary as Record<string, unknown> | null) ?? {};
    await this.prisma.cskhJobRun.update({
      where: { id: jobId },
      data: {
        summary: { ...prev, pauseRequested: true } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async isBackfillPauseRequestedNow(): Promise<boolean> {
    if (this.backfillPauseRequested) return true;
    if (!this.backfillJobId) return false;
    const remote = await this.redisQueue.isBackfillPauseRequested(this.backfillJobId);
    if (remote) this.backfillPauseRequested = true;
    return remote;
  }

  private async isBackfillCancelledNow(): Promise<boolean> {
    if (this.backfillCancelRequested) return true;
    if (!this.backfillJobId) return false;
    if (await this.redisQueue.isBackfillCancelRequested(this.backfillJobId)) {
      this.backfillCancelRequested = true;
      return true;
    }
    const job = await this.prisma.cskhJobRun.findUnique({
      where: { id: this.backfillJobId },
      select: { status: true },
    });
    return job?.status === 'cancelled';
  }

  private async finishBackfillPause(): Promise<void> {
    this.backfillState.running = false;
    this.backfillState.paused = true;
    this.backfillState.currentPage = null;
    await this.persistBackfillJob('paused', this.backfillCompletedPageIds);
    if (this.backfillJobId) {
      await this.redisQueue.clearBackfillPauseRequested(this.backfillJobId);
    }
    this.backfillPauseRequested = false;
    this.stopBackfillPausePoller();
  }

  private async finishBackfillCancel(): Promise<void> {
    this.backfillState.running = false;
    this.backfillState.paused = false;
    this.backfillState.currentPage = null;
    this.backfillState.finishedAt = new Date().toISOString();
    await this.persistBackfillJob('cancelled', this.backfillCompletedPageIds);
    if (this.backfillJobId) {
      await this.redisQueue.clearBackfillCancelRequested(this.backfillJobId);
      await this.redisQueue.clearBackfillPauseRequested(this.backfillJobId);
    }
    this.backfillPauseRequested = false;
    this.backfillCancelRequested = false;
    this.stopBackfillPausePoller();
    this.logger.log('[backfill] ĐÃ HỦY — dừng ngay, không chờ xong kênh');
  }

  private async persistBackfillJob(
    status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled',
    completedPageIds: string[],
    options?: { force?: boolean },
  ) {
    if (!this.backfillJobId) return;
    if (
      (status === 'running' || status === 'paused') &&
      (await this.isBackfillCancelledNow())
    ) {
      return;
    }
    const now = Date.now();
    if (
      !options?.force &&
      status === 'running' &&
      now - this.backfillLastProgressPersistAt < 2500
    ) {
      return;
    }
    if (status === 'running') this.backfillLastProgressPersistAt = now;
    const summary = {
      scope: this.backfillState.scope,
      total: this.backfillState.total,
      done: this.backfillState.done,
      currentPage: this.backfillState.currentPage,
      pageConvsDone: this.backfillState.pageConvsDone,
      addedMessages: this.backfillState.addedMessages,
      okPages: this.backfillState.okPages,
      errorPages: this.backfillState.errorPages,
      completedPageIds,
      paused: status === 'paused',
      pauseRequested: status === 'running' && this.backfillPauseRequested,
    };
    await this.prisma.cskhJobRun.update({
      where: { id: this.backfillJobId },
      data: {
        status,
        summary: summary as unknown as Prisma.InputJsonValue,
        finishedAt: status === 'running' ? null : new Date(),
      },
    });
  }

  private async getCachedPageConfig(pageId: string): Promise<FacebookCskhConfig | null> {
    const cached = this.configCache.get(pageId);
    if (cached && Date.now() - cached.at < this.configCacheTtlMs) {
      return cached.config;
    }
    const config = await this.prisma.facebookCskhConfig.findUnique({ where: { pageId } });
    this.configCache.set(pageId, { config, at: Date.now() });
    return config;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: FacebookGraphService,
    private readonly graphCoordinator: GraphApiCoordinatorService,
    private readonly realtime: CskhInboxRealtimeService,
    private readonly ai: AiService,
    private readonly sapoProducts: SapoProductService,
    private readonly inboxLabels: CskhInboxLabelsService,
    @Inject(forwardRef(() => RedisQueueService))
    private readonly redisQueue: RedisQueueService,
    @Inject(forwardRef(() => CskhService))
    private readonly cskh: CskhService,
  ) {}

  /** NV đang xem inbox — debounce 90s, 1 Redis SET tối đa / 60s. */
  private lastActivityMarkAt = 0;
  touchUserActivity(): void {
    const now = Date.now();
    if (now - this.lastActivityMarkAt < 120_000) return;
    this.lastActivityMarkAt = now;
    void this.redisQueue.markInboxActivity(120);
  }

  private readIntentCache(cacheKey: string, signature: string): CustomerIntentPayload | null {
    const row = this.intentCache.get(cacheKey);
    if (!row || Date.now() - row.at > this.intentCacheTtlMs) {
      if (row) this.intentCache.delete(cacheKey);
      return null;
    }
    if (row.signature !== signature) return null;
    return row.data;
  }

  private writeIntentCache(
    cacheKey: string,
    signature: string,
    data: CustomerIntentPayload,
  ): void {
    this.intentCache.set(cacheKey, { signature, at: Date.now(), data });
    if (this.intentCache.size > 400) {
      const oldest = this.intentCache.keys().next().value;
      if (oldest) this.intentCache.delete(oldest);
    }
  }

  private formatMessageRow(row: CskhInboxMessage): InboxMessagePayload {
    return {
      id: row.id,
      conversationId: row.conversationId,
      fbMessageId: row.fbMessageId,
      direction: row.direction,
      senderType: row.senderType,
      text: row.text,
      messageType: row.messageType,
      attachmentUrl: row.attachmentUrl,
      sentAt: row.sentAt.toISOString(),
      status: row.status,
    };
  }

  private formatConversationRow(conv: CskhInboxConversation): InboxConversationPayload {
    return {
      id: conv.id,
      pageId: conv.pageId,
      pageName: conv.pageName,
      participantPsid: conv.participantPsid,
      customerName: conv.customerName,
      customerPictureUrl: conv.customerPictureUrl,
      lastMessage: conv.lastMessage,
      lastMessageAt: conv.lastMessageAt?.toISOString() ?? null,
      unreadCount: conv.unreadCount,
      awaitingLabel: conv.awaitingLabel,
      fromAd: conv.fromAd,
      adTitle: conv.adTitle,
      adId: conv.adId,
      referralSource: conv.referralSource,
    };
  }

  private publishMessageRealtime(
    pageId: string,
    conversationId: string,
    messages: CskhInboxMessage[],
    analyzeIntent = false,
    tenantId?: string,
    conversation?: CskhInboxConversation,
  ): void {
    if (!messages.length) return;
    const startPublish = Date.now();
    this.logger.log(`[Realtime Publish Start] messagesCount=${messages.length} conversationId=${conversationId}`);

    void (async () => {
      const freshConv =
        conversation ||
        (await this.prisma.cskhInboxConversation.findUnique({
          where: { id: conversationId },
        }));
      const finalTenantId = tenantId || freshConv?.tenantId || undefined;
      const convPayload = freshConv ? this.formatConversationRow(freshConv) : undefined;

      // Push SSE ngay — không chờ query nhãn (tránh delay vài trăm ms khi pool DB bận)
      this.realtime.publish({
        type: 'message',
        pageId,
        conversationId,
        messages: messages.map((m) => this.formatMessageRow(m)),
        conversation: convPayload
          ? {
              ...convPayload,
              labelsLocked: false,
            }
          : undefined,
        tenantId: finalTenantId,
      });
      this.logger.log(
        `[Realtime Publish Done] conversationId=${conversationId} took ${Date.now() - startPublish}ms`,
      );

      if (analyzeIntent && messages.some((m) => m.senderType === 'customer')) {
        void this.redisQueue.enqueueIntent(conversationId, finalTenantId).catch((e) => {
          this.logger.warn(`Intent enqueue failed: ${(e as Error).message}`);
        });
      }

      void this.inboxLabels
        .getLabelsForConversation(conversationId)
        .then((labels) => {
          if (!labels.length || !convPayload) return;
          this.realtime.publish({
            type: 'conversation',
            pageId,
            conversationId,
            conversation: {
              id: conversationId,
              labels,
              labelsLocked: true,
            },
            tenantId: finalTenantId,
          });
        })
        .catch((e) => {
          if (!this.isInboxSchemaMigrationError(e)) {
            this.logger.debug(`Labels patch after message publish failed: ${(e as Error).message}`);
          }
        });
    })().catch((e) => {
      this.logger.warn(`publishMessageRealtime failed: ${(e as Error).message}`);
    });
  }

  async getCustomerIntent(
    conversationId: string,
    auditId?: string,
    tenantId?: string,
    forceSync = false,
  ): Promise<CustomerIntentPayload> {
    const conv = await findInboxConversationById(this.prisma, conversationId, tenantId);
    if (!conv) throw new NotFoundException('Hội thoại không tồn tại hoặc không có quyền');

    const rows = (
      await this.prisma.cskhInboxMessage.findMany({
        where: { conversationId },
        orderBy: { sentAt: 'desc' },
        take: 60,
        select: { direction: true, senderType: true, text: true, sentAt: true },
      })
    ).reverse();

    let aiMessages: Array<{ sender: string; text: string }>;
    const auditKey = auditId?.trim() || '';
    if (auditKey) {
      const audit = await this.prisma.chatAudit.findFirst({
        where: tenantId ? { id: auditKey, tenantId } : { id: auditKey },
        select: { transcript: true },
      });
      if (audit?.transcript) {
        aiMessages = capIntentMessages(mergeTranscriptWithInboxTail(audit.transcript, rows));
      } else {
        aiMessages = capIntentMessages(inboxToIntentMessages(rows));
      }
    } else {
      aiMessages = capIntentMessages(inboxToIntentMessages(rows));
    }

    const signature = `${auditKey}|${intentMessagesSignature(aiMessages)}`;
    const cacheKey = auditKey ? `${conversationId}:${auditKey}` : conversationId;

    const localCached = this.readIntentCache(cacheKey, signature);
    if (localCached) {
      return { ...localCached, isStale: false };
    }

    if (forceSync) {
      const analyzed = await this.ai.analyzeCustomerIntent({
        messages: aiMessages,
        customerName: conv.customerName,
      });

      const sapoConfigured = this.sapoProducts.isConfigured();
      let products: CustomerIntentPayload['products'];
      if (sapoConfigured) {
        const catalog = await this.sapoProducts.getCatalog();
        products = matchInterestedProducts(
          catalog,
          analyzed.productMentions ?? [],
          analyzed.topics,
          analyzed.summary,
        );
      }

      const payload: CustomerIntentPayload = {
        summary: analyzed.summary,
        intentLabel: analyzed.intentLabel,
        topics: analyzed.topics,
        urgency: analyzed.urgency,
        suggestedFocus: analyzed.suggestedFocus,
        suggestedReply: analyzed.suggestedReply,
        analyzedAt: new Date().toISOString(),
        productMentions: analyzed.productMentions,
        products,
        sapoConfigured,
      };
      
      this.writeIntentCache(cacheKey, signature, payload);
      return { ...payload, isStale: false };
    }

    // Trigger background analysis if stale/missing
    this.triggerBackgroundIntentAnalysis(
      conversationId,
      cacheKey,
      signature,
      aiMessages,
      conv.customerName,
      tenantId,
    );

    // Stale cache (signature khác) — trả bản cũ tạm trong khi AI chạy nền
    const staleRow = this.intentCache.get(cacheKey);
    if (staleRow?.data) {
      return { ...staleRow.data, isStale: true };
    }

    return {
      summary: 'Đang tải phân tích ý định từ AI...',
      intentLabel: 'Đang phân tích',
      topics: [],
      urgency: 'normal',
      suggestedFocus: 'Đang tạo hướng xử lý...',
      suggestedReply: 'Đang tạo câu trả lời gợi ý...',
      analyzedAt: '',
      isStale: true,
    };
  }

  private triggerBackgroundIntentAnalysis(
    conversationId: string,
    cacheKey: string,
    signature: string,
    aiMessages: Array<{ sender: string; text: string }>,
    customerName: string | null,
    tenantId?: string,
  ) {
    if (this.pendingIntentRequests.has(cacheKey)) {
      return;
    }
    this.pendingIntentRequests.add(cacheKey);

    void (async () => {
      try {
        const analyzed = await this.ai.analyzeCustomerIntent({
          messages: aiMessages,
          customerName,
        });

        const sapoConfigured = this.sapoProducts.isConfigured();
        let products: CustomerIntentPayload['products'];
        if (sapoConfigured) {
          const catalog = await this.sapoProducts.getCatalog();
          products = matchInterestedProducts(
            catalog,
            analyzed.productMentions ?? [],
            analyzed.topics,
            analyzed.summary,
          );
        }

        const payload: CustomerIntentPayload = {
          summary: analyzed.summary,
          intentLabel: analyzed.intentLabel,
          topics: analyzed.topics,
          urgency: analyzed.urgency,
          suggestedFocus: analyzed.suggestedFocus,
          suggestedReply: analyzed.suggestedReply,
          analyzedAt: new Date().toISOString(),
          productMentions: analyzed.productMentions,
          products,
          sapoConfigured,
        };

        this.writeIntentCache(cacheKey, signature, payload);

        // Broadcast to clients via SSE
        this.realtime.publish({
          type: 'intent',
          conversationId,
          intent: payload,
          tenantId,
        });
      } catch (err) {
        this.logger.error(`Background intent analysis failed: ${(err as Error).message}`);
      } finally {
        this.pendingIntentRequests.delete(cacheKey);
      }
    })();
  }

  async analyzeAndBroadcastIntent(conversationId: string, tenantId?: string) {
    const intent = await this.getCustomerIntent(conversationId, undefined, tenantId, true);
    this.realtime.publish({ type: 'intent', conversationId, intent, tenantId });
  }

  verifyWebhookToken(mode: string, token: string, challenge: string) {
    if (mode === 'subscribe' && token === getFacebookWebhookVerifyToken()) {
      return challenge;
    }
    throw new BadRequestException('Webhook verify failed');
  }

  async handleWebhookPayload(payload: unknown) {
    const startWebhook = Date.now();
    const body = payload as {
      object?: string;
      entry?: Array<{
        id?: string;
        messaging?: WebhookMessagingEvent[];
      }>;
    };
    if (body.object !== 'page' || !Array.isArray(body.entry)) return { ok: true };
    const workerAlive = await this.redisQueue.isAuditWorkerAlive();
    let eventCount = 0;
    let queuedCount = 0;
    let inlineCount = 0;
    for (const entry of body.entry) {
      const pageId = String(entry.id || '');
      if (!pageId) continue;
      for (const event of entry.messaging ?? []) {
        eventCount++;
        // Worker sống → xếp hàng Redis (không block API). Worker chết → xử lý ngay trên API để SSE realtime không đứt.
        let queued = false;
        if (workerAlive) {
          queued = await this.redisQueue.enqueueWebhookMessaging(
            pageId,
            event as unknown as Record<string, unknown>,
          );
        }
        if (queued) {
          queuedCount++;
        } else {
          inlineCount++;
          void this.ingestMessagingEvent(pageId, event).catch((err) => {
            this.logger.error(
              `Failed to ingest webhook messaging event page=${pageId}: ${err.message}`,
              err.stack,
            );
          });
        }
      }
    }
    this.logger.log(
      `[Webhook] ${eventCount} events (queued=${queuedCount}, inline=${inlineCount}, worker=${workerAlive ? 'up' : 'down'}), ${Date.now() - startWebhook}ms`,
    );
    return { ok: true };
  }

  async ingestMessagingEvent(pageId: string, event: WebhookMessagingEvent) {
    const startIngest = Date.now();
    await this.redisQueue.markInboxActivity();
    const senderId = event.sender?.id;
    this.logger.log(`[Webhook Worker Ingest Start] pageId=${pageId} sender=${senderId}`);
    const msg = event.message;
    const referral = event.referral ?? msg?.referral;
    if (referral) {
      await this.applyReferralFromWebhook(pageId, event, referral);
    }

    // Handle typing indicator from Facebook Webhook
    const senderAction = (event as any).sender_action;
    if (senderAction) {
      const senderPsid = String(event.sender?.id || '');
      const recipientPsid = String(event.recipient?.id || '');
      if (senderPsid) {
        const isFromPage = senderPsid === pageId;
        const customerPsid = isFromPage ? recipientPsid : senderPsid;
        if (customerPsid && customerPsid !== pageId) {
          const conv = await this.prisma.cskhInboxConversation.findUnique({
            where: { pageId_participantPsid: { pageId, participantPsid: customerPsid } },
          });
          if (conv) {
            this.realtime.publish({
              type: 'typing',
              conversationId: conv.id,
              pageId,
              tenantId: conv.tenantId || undefined,
            });
          }
        }
      }
      return;
    }

    // Handle read receipt from Facebook Webhook
    const read = (event as any).read;
    if (read) {
      const senderPsid = String(event.sender?.id || '');
      const recipientPsid = String(event.recipient?.id || '');
      if (senderPsid) {
        const isFromPage = senderPsid === pageId;
        const customerPsid = isFromPage ? recipientPsid : senderPsid;
        if (customerPsid && customerPsid !== pageId) {
          const conv = await this.prisma.cskhInboxConversation.findUnique({
            where: { pageId_participantPsid: { pageId, participantPsid: customerPsid } },
          });
          if (conv) {
            if (isFromPage) {
              const updatedConv = await this.prisma.cskhInboxConversation.update({
                where: { id: conv.id },
                data: { unreadCount: 0 },
              });

              // Mark inbound messages as read in our DB
              const msgWhere: any = {
                conversationId: conv.id,
                direction: 'inbound',
                status: { notIn: ['read', 'failed'] },
              };
              if (conv.tenantId) msgWhere.tenantId = conv.tenantId;
              await this.prisma.cskhInboxMessage.updateMany({
                where: msgWhere,
                data: { status: 'read' },
              });

              this.realtime.publish({
                type: 'read-receipt',
                conversationId: conv.id,
                pageId,
                conversation: this.formatConversationRow(updatedConv),
                tenantId: conv.tenantId || undefined,
              });
            }
          }
        }
      }
      return;
    }

    if (!msg?.text && !msg?.mid && !msg?.attachments?.length && !msg?.sticker_id) return;
    const senderPsid = String(event.sender?.id || '');
    const recipientPsid = String(event.recipient?.id || '');
    if (!senderPsid) return;

    const isEcho = Boolean(msg.is_echo);

    const config = await this.getCachedPageConfig(pageId);
    const pageName = config?.pageName ?? null;

    const prelimCustomer = resolveMessengerCustomerPsid(senderPsid, recipientPsid, pageId, {
      isEcho,
    });
    const existingConv = prelimCustomer
      ? await this.prisma.cskhInboxConversation.findUnique({
          where: { pageId_participantPsid: { pageId, participantPsid: prelimCustomer } },
        })
      : null;

    const customerPsid =
      resolveMessengerCustomerPsid(senderPsid, recipientPsid, pageId, {
        isEcho,
        participantPsid: existingConv?.participantPsid,
      }) ?? prelimCustomer;
    if (!customerPsid || customerPsid === pageId) return;

    const isFromPage = !isMessengerFromCustomer(senderPsid, customerPsid);

    let customerName = existingConv?.customerName ?? null;
    let customerPictureUrl = existingConv?.customerPictureUrl ?? null;

    const conv = await this.prisma.cskhInboxConversation.upsert({
      where: { pageId_participantPsid: { pageId, participantPsid: customerPsid } },
      create: {
        pageId,
        pageName,
        participantPsid: customerPsid,
        customerName: customerName || 'Khách hàng Messenger',
        customerPictureUrl,
        lastMessage: msg.text ?? '',
        lastMessageAt: new Date(event.timestamp ?? Date.now()),
        unreadCount: isFromPage ? 0 : 1,
        tenantId: config?.tenantId || null,
      },
      update: {
        pageName: pageName ?? undefined,
        customerName: customerName ?? undefined,
        customerPictureUrl: customerPictureUrl ?? undefined,
        lastMessage: msg.text ?? undefined,
        lastMessageAt: new Date(event.timestamp ?? Date.now()),
        unreadCount: isFromPage ? 0 : { increment: 1 },
        tenantId: config?.tenantId || undefined,
      },
    });

    // Asynchronously fetch profile for new conversations in the background
    if (!existingConv && !isFromPage && config?.pageAccessToken) {
      void this.enrichNewConversationProfile(conv.id, customerPsid, config.pageAccessToken).catch((e) => {
        this.logger.warn(`Background new profile enrichment failed: ${(e as Error).message}`);
      });
    }

    if (msg.mid) {
      let existing = await this.prisma.cskhInboxMessage.findUnique({
        where: { fbMessageId: msg.mid },
      });
      const attCount = msg.attachments?.length ?? 0;
      if (existing && attCount <= 1) {
        const senderType = isFromPage ? 'staff' : 'customer';
        const direction = isFromPage ? 'outbound' : 'inbound';
        if (existing.senderType !== senderType || existing.direction !== direction) {
          existing = await this.prisma.cskhInboxMessage.update({
            where: { id: existing.id },
            data: { senderType, direction },
          });
        }
        this.publishMessageRealtime(
          pageId,
          conv.id,
          [existing],
          !isFromPage,
          conv.tenantId || undefined,
          conv,
        );
        return;
      }
    }

    const text = (msg.text ?? '').trim();
    if (text && this.graph.isStoredMessageNoise(text)) return;

    const sentAt = new Date(event.timestamp ?? Date.now());
    const webhookAttachments = msg.attachments ?? [];
    let mediaItems: Array<{ url: string | null; messageType: string }> = [];
    let needsBackgroundMedia = false;

    if (webhookAttachments.length > 0) {
      for (const att of webhookAttachments) {
        const url = att.payload?.url?.startsWith('http') ? att.payload.url : null;
        const messageType =
          att.type === 'video' ? 'video' : att.type === 'image' || att.type === 'file' ? 'image' : 'text';
        mediaItems.push({ url, messageType });
      }
    } else if (msg.sticker_id) {
      mediaItems.push({ url: null, messageType: 'sticker' });
    } else {
      mediaItems.push({ url: null, messageType: 'text' });
    }

    if (
      msg.mid &&
      config?.pageAccessToken &&
      mediaItems.some((m) => !m.url && m.messageType !== 'text' && m.messageType !== 'sticker')
    ) {
      // Không chờ Graph khi audit/inbox đang bận — push SSE trước, resolve media nền sau.
      needsBackgroundMedia = true;
    }

    const createdMessages: CskhInboxMessage[] = [];

    for (let i = 0; i < mediaItems.length; i++) {
      const item = mediaItems[i];
      const displayText =
        i === 0
          ? text ||
            (item.messageType === 'video'
              ? ''
              : item.messageType === 'image'
                ? '[Ảnh]'
                : item.messageType === 'sticker'
                  ? '[Sticker]'
                  : '[attachment]')
          : item.messageType === 'image' || item.messageType === 'video'
            ? ''
            : '';

      const fbMessageId = i === 0 ? (msg.mid ?? null) : null;

      if (fbMessageId) {
        let existing = await this.prisma.cskhInboxMessage.findUnique({
          where: { fbMessageId },
        });
        if (existing) {
          const senderType = isFromPage ? 'staff' : 'customer';
          const direction = isFromPage ? 'outbound' : 'inbound';
          const patch: Record<string, unknown> = {};
          if (existing.senderType !== senderType) {
            patch.senderType = senderType;
            patch.direction = direction;
          }
          if (item.url && !existing.attachmentUrl) {
            patch.attachmentUrl = item.url;
            patch.messageType = item.messageType;
            patch.text = displayText === '[Ảnh]' ? '' : displayText;
          }
          if (Object.keys(patch).length) {
            const updated = await this.prisma.cskhInboxMessage.update({
              where: { id: existing.id },
              data: patch,
            });
            createdMessages.push(updated);
          } else {
            createdMessages.push(existing);
          }
          continue;
        }
      } else if (item.url) {
        const sibling = await this.prisma.cskhInboxMessage.findFirst({
          where: {
            conversationId: conv.id,
            senderType: isFromPage ? 'staff' : 'customer',
            attachmentUrl: item.url,
            sentAt: {
              gte: new Date(sentAt.getTime() - 2000),
              lte: new Date(sentAt.getTime() + 2000),
            },
          },
        });
        if (sibling) continue;
      }

      const created = await this.prisma.cskhInboxMessage.create({
        data: {
          conversationId: conv.id,
          fbMessageId,
          direction: isFromPage ? 'outbound' : 'inbound',
          senderType: isFromPage ? 'staff' : 'customer',
          text: displayText,
          messageType: item.messageType,
          attachmentUrl: item.url,
          sentAt,
          status: 'sent',
          tenantId: config?.tenantId || null,
        },
      });
      createdMessages.push(created);
    }

    await this.publishMessageRealtime(
      pageId,
      conv.id,
      createdMessages,
      createdMessages.some((m) => m.senderType === 'customer'),
      conv.tenantId || undefined,
      conv,
    );

    if (needsBackgroundMedia && msg.mid && config?.pageAccessToken) {
      void this.resolveWebhookMediaInBackground(
        pageId,
        conv.id,
        msg.mid,
        config.pageAccessToken,
        conv.tenantId || undefined,
      ).catch((e) => {
        this.logger.warn(`Background webhook media resolve failed: ${(e as Error).message}`);
      });
    }

    this.logger.log(`[Webhook Worker Ingest Done] pageId=${pageId} sender=${senderId} took ${Date.now() - startIngest}ms`);
  }

  /** Resolve ảnh/video từ Graph sau khi đã push SSE — không chặn realtime inbox. */
  private async resolveWebhookMediaInBackground(
    pageId: string,
    conversationId: string,
    fbMessageId: string,
    pageAccessToken: string,
    tenantId?: string,
  ) {
    const existing = await this.prisma.cskhInboxMessage.findUnique({
      where: { fbMessageId },
    });
    if (!existing || existing.attachmentUrl) return;

    let resolvedItems: Array<{ url: string | null; messageType: string }> = [];
    const resolvedAll = await this.graph.resolveAllMessageMediaUrls(fbMessageId, pageAccessToken);
    if (resolvedAll.length) {
      resolvedItems = resolvedAll.map((r) => ({ url: r.url, messageType: r.messageType }));
    } else {
      const resolved = await this.graph.resolveMessageMediaUrl(fbMessageId, pageAccessToken);
      if (resolved.url) {
        resolvedItems = [{ url: resolved.url, messageType: resolved.messageType ?? 'image' }];
      }
    }
    if (!resolvedItems.length) return;

    const updated = await this.prisma.cskhInboxMessage.update({
      where: { id: existing.id },
      data: {
        attachmentUrl: resolvedItems[0].url,
        messageType: resolvedItems[0].messageType,
        text: existing.text === '[Ảnh]' ? '' : existing.text,
      },
    });

    this.publishMessageRealtime(
      pageId,
      conversationId,
      [updated],
      false,
      tenantId,
    );
  }

  /** Lưu nguồn quảng cáo từ webhook messaging_referrals / message.referral. */
  private async applyReferralFromWebhook(
    pageId: string,
    event: WebhookMessagingEvent,
    referral: FbWebhookReferral,
  ) {
    const parsed = parseWebhookReferral(referral);
    if (!parsed.fromAd) return;

    const senderPsid = String(event.sender?.id || '');
    const recipientPsid = String(event.recipient?.id || '');
    const customerPsid = senderPsid === pageId ? recipientPsid : senderPsid;
    if (!customerPsid || customerPsid === pageId) return;

    const config = await this.getCachedPageConfig(pageId);
    const pageName = config?.pageName ?? null;
    const referralAt = new Date(event.timestamp ?? Date.now());

    await this.prisma.cskhInboxConversation.upsert({
      where: { pageId_participantPsid: { pageId, participantPsid: customerPsid } },
      create: {
        pageId,
        pageName,
        participantPsid: customerPsid,
        fromAd: true,
        adId: parsed.adId,
        adTitle: parsed.adTitle,
        referralSource: parsed.referralSource,
        referralAt,
        tenantId: config?.tenantId || null,
      },
      update: {
        pageName: pageName ?? undefined,
        fromAd: true,
        adId: parsed.adId ?? undefined,
        adTitle: parsed.adTitle ?? undefined,
        referralSource: parsed.referralSource ?? undefined,
        referralAt,
        tenantId: config?.tenantId || undefined,
      },
    });
  }

  /** Heuristic: tin hệ thống Graph báo khách vào từ quảng cáo (không có ad_id). */
  private async markAdFromGraphMessages(
    conversationId: string,
    rawMsgs: FbMessage[],
  ): Promise<void> {
    const hint = detectAdFromFbMessages(rawMsgs);
    if (!hint.fromAd) return;

    await this.prisma.cskhInboxConversation.updateMany({
      where: { id: conversationId, fromAd: false },
      data: {
        fromAd: true,
        referralSource: hint.referralSource ?? 'HEURISTIC',
        referralAt: new Date(),
      },
    });
  }

  private isInboxSchemaMigrationError = isInboxSchemaMigrationError;

  private unreadStatusWhere(includeAwaitingLabel: boolean): Prisma.CskhInboxConversationWhereInput {
    if (includeAwaitingLabel) {
      return { OR: [{ unreadCount: { gt: 0 } }, { awaitingLabel: true }] };
    }
    return { unreadCount: { gt: 0 } };
  }

  /** Cần `npx prisma generate` sau khi đổi schema — filter qua relation labelAssignments. */
  private labelIdWhere(labelId: string): Prisma.CskhInboxConversationWhereInput {
    return { labelAssignments: { some: { labelId } } } as Prisma.CskhInboxConversationWhereInput;
  }

  private unlabeledWhere(): Prisma.CskhInboxConversationWhereInput {
    return { labelAssignments: { none: {} } } as Prisma.CskhInboxConversationWhereInput;
  }

  private buildListConversationWhere(
    pageId: string | undefined,
    tenantId: string | undefined,
    opts: {
      fromAdOnly?: boolean;
      unreadOnly?: boolean;
      organicOnly?: boolean;
      search?: string;
      sinceDays?: number;
      labelId?: string;
      unlabeledOnly?: boolean;
      cursor?: { lastMessageAt: Date; id: string } | null;
    },
    flags: { includeAwaitingInUnread: boolean; includeLabelFilters: boolean },
  ): Prisma.CskhInboxConversationWhereInput {
    const andClauses: Prisma.CskhInboxConversationWhereInput[] = [];
    if (pageId) andClauses.push({ pageId });
    if (tenantId) andClauses.push({ tenantId });
    if (opts.fromAdOnly) andClauses.push({ fromAd: true });
    if (opts.unreadOnly) andClauses.push(this.unreadStatusWhere(flags.includeAwaitingInUnread));
    if (opts.organicOnly) andClauses.push({ fromAd: false });
    if (flags.includeLabelFilters && opts.labelId) {
      andClauses.push(this.labelIdWhere(opts.labelId));
    }
    if (flags.includeLabelFilters && opts.unlabeledOnly) {
      andClauses.push(this.unlabeledWhere());
    }
    const sinceDays =
      opts.sinceDays != null && opts.sinceDays > 0
        ? Math.min(Math.floor(opts.sinceDays), 365)
        : undefined;
    if (sinceDays) {
      andClauses.push({
        lastMessageAt: { gte: new Date(Date.now() - sinceDays * 86_400_000) },
      });
    }
    const search = opts.search?.trim();
    if (search) {
      andClauses.push({
        OR: [
          { customerName: { contains: search, mode: 'insensitive' } },
          { lastMessage: { contains: search, mode: 'insensitive' } },
          { participantPsid: { contains: search } },
          { pageName: { contains: search, mode: 'insensitive' } },
        ],
      });
    }
    if (opts.cursor) {
      andClauses.push({
        OR: [
          { lastMessageAt: { lt: opts.cursor.lastMessageAt } },
          { lastMessageAt: opts.cursor.lastMessageAt, id: { lt: opts.cursor.id } },
        ],
      });
    }
    return andClauses.length > 0 ? { AND: andClauses } : {};
  }

  async getConversationStats(pageId?: string, tenantId?: string) {
    const cacheKey = `${tenantId ?? '__all__'}:${pageId ?? '__all__'}`;
    const cached = this.conversationStatsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.conversationStatsTtlMs) {
      return cached.data;
    }

    const where: Prisma.CskhInboxConversationWhereInput = {};
    if (pageId) where.pageId = pageId;
    if (tenantId) where.tenantId = tenantId;

    const [total, fromAd] = await Promise.all([
      this.prisma.cskhInboxConversation.count({ where }),
      this.prisma.cskhInboxConversation.count({ where: { ...where, fromAd: true } }),
    ]);

    let unread = 0;
    try {
      unread = await this.prisma.cskhInboxConversation.count({
        where: { ...where, ...this.unreadStatusWhere(true) },
      });
    } catch (e) {
      if (!this.isInboxSchemaMigrationError(e)) throw e;
      this.logger.warn('[getConversationStats] awaiting_label chưa migrate — fallback unreadCount');
      unread = await this.prisma.cskhInboxConversation.count({
        where: { ...where, unreadCount: { gt: 0 } },
      });
    }

    const result = {
      total,
      fromAd,
      unread,
      normal: Math.max(0, total - fromAd),
    };
    this.conversationStatsCache.set(cacheKey, { at: Date.now(), data: result });
    return result;
  }

  async listConversations(
    pageId?: string,
    tenantId?: string,
    opts?: {
      fromAdOnly?: boolean;
      unreadOnly?: boolean;
      organicOnly?: boolean;
      limit?: number;
      cursor?: string;
      search?: string;
      sinceDays?: number;
      labelId?: string;
      unlabeledOnly?: boolean;
      includeLabels?: boolean;
    },
  ): Promise<{ items: CskhInboxConversation[]; nextCursor: string | null; hasMore: boolean }> {
    this.touchUserActivity();
    const pageSize = Math.min(Math.max(Math.floor(opts?.limit ?? 50), 10), 100);
    const isScrollPage = !!opts?.cursor;
    const cursor = this.decodeInboxListCursor(opts?.cursor);
    const hasLabelFilter = !!(opts?.labelId || opts?.unlabeledOnly);
    const hasListFilter = !!(
      opts?.fromAdOnly ||
      opts?.unreadOnly ||
      opts?.organicOnly ||
      opts?.search?.trim() ||
      hasLabelFilter
    );
    const needLabels =
      opts?.includeLabels === true || hasLabelFilter;
    const listOpts = {
      fromAdOnly: opts?.fromAdOnly,
      unreadOnly: opts?.unreadOnly,
      organicOnly: opts?.organicOnly,
      search: opts?.search,
      sinceDays: opts?.sinceDays,
      labelId: opts?.labelId,
      unlabeledOnly: opts?.unlabeledOnly,
      cursor,
    };

    if (!isScrollPage && !hasListFilter) {
      void this.maybeBackfillAdReferralsFromDb(tenantId).catch((e) => {
        this.logger.warn(`Ad referral backfill failed: ${(e as Error).message}`);
      });
      void this.maybeTriggerListSync(pageId, tenantId).catch((e) => {
        this.logger.warn(`Background list sync trigger failed: ${(e as Error).message}`);
      });
    }

    const selectWithAwaiting = {
      id: true,
      pageId: true,
      pageName: true,
      fbConversationId: true,
      participantPsid: true,
      customerName: true,
      customerPictureUrl: true,
      fromAd: true,
      adId: true,
      adTitle: true,
      referralSource: true,
      lastMessage: true,
      lastMessageAt: true,
      unreadCount: true,
      awaitingLabel: true,
      updatedAt: true,
    } as const;

    const selectLegacy = {
      id: true,
      pageId: true,
      pageName: true,
      fbConversationId: true,
      participantPsid: true,
      customerName: true,
      customerPictureUrl: true,
      fromAd: true,
      adId: true,
      adTitle: true,
      referralSource: true,
      lastMessage: true,
      lastMessageAt: true,
      unreadCount: true,
      updatedAt: true,
    } as const;

    const fetchPage = async (flags: { includeAwaitingInUnread: boolean; includeLabelFilters: boolean }) => {
      const where = this.buildListConversationWhere(pageId, tenantId, listOpts, flags);
      const select = flags.includeAwaitingInUnread ? selectWithAwaiting : selectLegacy;
      const rows = await this.prisma.cskhInboxConversation.findMany({
        where,
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        take: pageSize + 1,
        select,
      });
      if (!flags.includeAwaitingInUnread) {
        return rows.map((r) => ({ ...r, awaitingLabel: false }));
      }
      return rows;
    };

    let rows: Array<
      Pick<
        CskhInboxConversation,
        | 'id'
        | 'pageId'
        | 'pageName'
        | 'fbConversationId'
        | 'participantPsid'
        | 'customerName'
        | 'customerPictureUrl'
        | 'fromAd'
        | 'adId'
        | 'adTitle'
        | 'referralSource'
        | 'lastMessage'
        | 'lastMessageAt'
        | 'unreadCount'
        | 'updatedAt'
      > & { awaitingLabel?: boolean }
    >;
    try {
      rows = await fetchPage({ includeAwaitingInUnread: true, includeLabelFilters: true });
    } catch (e) {
      if (!this.isInboxSchemaMigrationError(e)) throw e;
      this.logger.warn('[listConversations] schema chưa migrate — fallback không nhãn/awaiting_label');
      if (opts?.labelId || opts?.unlabeledOnly) {
        return { items: [], nextCursor: null, hasMore: false };
      }
      rows = await fetchPage({ includeAwaitingInUnread: false, includeLabelFilters: false });
    }

    const hasMore = rows.length > pageSize;
    const slice = hasMore ? rows.slice(0, pageSize) : rows;
    const items =
      isScrollPage || !opts?.unreadOnly
        ? (slice as CskhInboxConversation[])
        : await this.correctUnreadFromLastMessage(slice as CskhInboxConversation[]);
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last?.lastMessageAt
        ? this.encodeInboxListCursor(last.lastMessageAt, last.id)
        : null;

    let labelMap = new Map<string, InboxLabelDto[]>();
    if (needLabels) {
      try {
        labelMap = await this.inboxLabels.attachLabelsMap(items.map((i) => i.id));
      } catch (e) {
        if (!this.isInboxSchemaMigrationError(e)) throw e;
      }
    }

    const itemsWithLabels = items.map((i) => ({
      ...i,
      labels: needLabels ? (labelMap.get(i.id) ?? []) : [],
      labelsLocked: needLabels ? (labelMap.get(i.id) ?? []).length > 0 : false,
    }));

    return { items: itemsWithLabels, nextCursor, hasMore };
  }

  private encodeInboxListCursor(lastMessageAt: Date, id: string): string {
    return `${lastMessageAt.toISOString()}|${id}`;
  }

  private decodeInboxListCursor(
    cursor?: string,
  ): { lastMessageAt: Date; id: string } | null {
    if (!cursor?.trim()) return null;
    const sep = cursor.lastIndexOf('|');
    if (sep <= 0) return null;
    const at = new Date(cursor.slice(0, sep));
    const id = cursor.slice(sep + 1);
    if (!id || Number.isNaN(at.getTime())) return null;
    return { lastMessageAt: at, id };
  }

  /** Tương thích code cũ — lấy tối đa N trang (audit, v.v.). */
  async listConversationsLegacy(
    pageId?: string,
    tenantId?: string,
    opts?: {
      fromAdOnly?: boolean;
      unreadOnly?: boolean;
      organicOnly?: boolean;
      maxItems?: number;
      limit?: number;
    },
  ): Promise<CskhInboxConversation[]> {
    const maxItems = Math.min(opts?.maxItems ?? opts?.limit ?? 2000, 5000);
    const all: CskhInboxConversation[] = [];
    let cursor: string | undefined;
    while (all.length < maxItems) {
      const page = await this.listConversations(pageId, tenantId, {
        ...opts,
        cursor,
        limit: 100,
      });
      all.push(...page.items);
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return all;
  }

  /** Quét DB gắn fromAd cho hội thoại có tin hệ thống "vào từ quảng cáo" (kể cả tiếng Thái). */
  async backfillAdReferralsFromDb(tenantId?: string): Promise<{ updated: number }> {
    if (await this.redisQueue.isInboxHot()) {
      return { updated: 0 };
    }
    let updated = 0;
    for (const sub of AD_REFERRAL_ILIKE_SUBSTRINGS) {
      const pattern = `%${sub}%`;
      const count = tenantId
        ? await this.prisma.$executeRaw`
            UPDATE cskh_inbox_conversations AS c
            SET
              from_ad = true,
              referral_source = COALESCE(c.referral_source, 'HEURISTIC'),
              referral_at = COALESCE(c.referral_at, c.created_at)
            WHERE c.from_ad = false
              AND c.tenant_id = ${tenantId}::uuid
              AND EXISTS (
                SELECT 1 FROM cskh_inbox_messages AS m
                WHERE m.conversation_id = c.id
                  AND m.text ILIKE ${pattern}
              )
          `
        : await this.prisma.$executeRaw`
            UPDATE cskh_inbox_conversations AS c
            SET
              from_ad = true,
              referral_source = COALESCE(c.referral_source, 'HEURISTIC'),
              referral_at = COALESCE(c.referral_at, c.created_at)
            WHERE c.from_ad = false
              AND EXISTS (
                SELECT 1 FROM cskh_inbox_messages AS m
                WHERE m.conversation_id = c.id
                  AND m.text ILIKE ${pattern}
              )
          `;
      updated += Number(count) || 0;
    }
    if (updated > 0) {
      this.logger.log(`[ad-backfill] Gắn tag Ads cho ${updated} hội thoại (tenant=${tenantId ?? 'all'})`);
    }
    return { updated };
  }

  private async maybeBackfillAdReferralsFromDb(tenantId?: string): Promise<void> {
    if (this.adReferralBackfillRunning) return;
    if (Date.now() - this.lastAdReferralBackfillAt < this.adReferralBackfillCooldownMs) return;
    this.adReferralBackfillRunning = true;
    this.lastAdReferralBackfillAt = Date.now();
    try {
      await this.backfillAdReferralsFromDb(tenantId);
    } finally {
      this.adReferralBackfillRunning = false;
    }
  }

  /** Gắn Ads từ tin cũ nhất trong DB (khi sync Graph không còn tin hệ thống). */
  private async markAdFromStoredMessages(conversationId: string): Promise<void> {
    const rows = await this.prisma.cskhInboxMessage.findMany({
      where: { conversationId },
      orderBy: { sentAt: 'asc' },
      take: 40,
      select: { text: true },
    });
    const hint = detectAdFromFbMessages(rows.map((r) => ({ message: r.text })));
    if (!hint.fromAd) return;
    await this.prisma.cskhInboxConversation.updateMany({
      where: { id: conversationId, fromAd: false },
      data: {
        fromAd: true,
        referralSource: hint.referralSource ?? 'HEURISTIC',
      },
    });
  }

  /** Kích hoạt sync nhẹ từ Graph sau khi trả danh sách — không block request. */
  private async maybeTriggerListSync(pageId?: string, tenantId?: string): Promise<void> {
    if (!this.rotatingSyncEnabled) return;
    if (pageId) {
      const auditRunning = await this.isAuditJobRunning(tenantId);
      const inboxHot = await this.redisQueue.isInboxHot();
      if (auditRunning || inboxHot) return;

      const syncKey = `${pageId}:${tenantId ?? ''}`;
      const lastSync = this.lastListSync.get(syncKey) ?? 0;
      if (Date.now() - lastSync < this.listSyncCooldownMs) return;

      this.lastListSync.set(syncKey, Date.now());
      await this.syncFromGraph(pageId, tenantId, { lightweight: true });
      return;
    }

    await this.maybeRotatingSyncAllPages(tenantId);
  }

  private async isAuditJobRunning(tenantId?: string): Promise<boolean> {
    const running = await this.prisma.cskhJobRun.findFirst({
      where: {
        type: 'audit',
        status: 'running',
        ...(tenantId ? { tenantId } : {}),
      },
      select: { id: true },
    });
    return !!running;
  }

  /**
   * Xem "Tất cả Page": quét luân phiên vài page/lần (~45s) để bắt tin mới mà không quét 87 page cùng lúc.
   */
  private async maybeRotatingSyncAllPages(tenantId?: string): Promise<void> {
    if (Date.now() - this.lastAllPagesRotatingSync < this.allPagesSyncCooldownMs) return;
    if (await this.isAuditJobRunning(tenantId)) return;
    if (await this.redisQueue.isInboxHot()) return;
    if (await this.redisQueue.isInboxSyncActive()) return;
    if ((await this.redisQueue.getWebhookQueueDepth()) > 0) return;

    const where: Prisma.FacebookCskhConfigWhereInput = {
      pageAccessToken: { not: '' },
      ...(tenantId ? { tenantId } : {}),
    };
    const pages = await this.prisma.facebookCskhConfig.findMany({
      where,
      select: { pageId: true, pageName: true, pageAccessToken: true, tenantId: true },
      orderBy: { pageName: 'asc' },
    });
    if (!pages.length) return;

    this.lastAllPagesRotatingSync = Date.now();
    const batchSize = Math.min(this.allPagesSyncBatch, pages.length);
    const batch: typeof pages = [];
    for (let i = 0; i < batchSize; i++) {
      batch.push(pages[(this.allPagesSyncCursor + i) % pages.length]);
    }
    this.allPagesSyncCursor = (this.allPagesSyncCursor + batchSize) % pages.length;

    this.logger.log(
      `[rotating-sync] Quét ${batch.length}/${pages.length} page (bắt đầu từ ${batch[0]?.pageName || batch[0]?.pageId})`,
    );

    this.graphCoordinator.beginInboxSync();
    await this.redisQueue.markInboxSyncActive();
    try {
      for (const page of batch) {
        if (await this.redisQueue.isInboxHot()) {
          this.logger.log('[rotating-sync] Dừng — webhook/inbox ưu tiên');
          break;
        }
        if (!page.pageAccessToken) continue;
        try {
          await this.syncSinglePageFromGraph(
            page as FacebookCskhConfig,
            false,
            true,
          );
        } catch (e) {
          this.logger.warn(
            `[rotating-sync] Lỗi page ${page.pageName || page.pageId}: ${(e as Error).message}`,
          );
        }
      }
    } finally {
      this.graphCoordinator.endInboxSync();
      await this.redisQueue.clearInboxSyncActive();
    }
  }

  private async correctUnreadFromLastMessage(
    conversations: CskhInboxConversation[],
  ): Promise<CskhInboxConversation[]> {
    if (!conversations.length) return conversations;
    const needsFix = conversations.some((c) => c.unreadCount > 0 || c.awaitingLabel);
    if (!needsFix) return conversations;

    const ids = conversations
      .filter((c) => c.unreadCount > 0 || c.awaitingLabel)
      .map((c) => c.id);
    if (!ids.length) return conversations;
    const lastMsgs = await this.prisma.$queryRaw<
      Array<{ conversationId: string; senderType: string; direction: string }>
    >`
      SELECT DISTINCT ON (m.conversation_id)
        m.conversation_id AS "conversationId",
        m.sender_type AS "senderType",
        m.direction AS "direction"
      FROM cskh_inbox_messages m
      WHERE m.conversation_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY m.conversation_id, m.sent_at DESC
    `;

    const lastByConv = new Map(lastMsgs.map((m) => [m.conversationId, m]));
    const toClearUnread: string[] = [];
    const toClearAwaiting: string[] = [];

    const result = conversations.map((conv) => {
      const last = lastByConv.get(conv.id);
      if (!last) return conv;
      const shopRepliedLast = isStaffLastMessage(last);
      let next = conv;
      if (shopRepliedLast && conv.unreadCount !== 0) {
        toClearUnread.push(conv.id);
        next = { ...next, unreadCount: 0 };
      }
      if (shopRepliedLast && conv.awaitingLabel) {
        toClearAwaiting.push(conv.id);
        next = { ...next, awaitingLabel: false };
      }
      return next;
    });

    if (toClearUnread.length) {
      void this.prisma.cskhInboxConversation
        .updateMany({
          where: { id: { in: toClearUnread } },
          data: { unreadCount: 0 },
        })
        .catch((e) => {
          this.logger.warn(`correctUnreadFromLastMessage DB update failed: ${(e as Error).message}`);
        });
    }
    if (toClearAwaiting.length) {
      void this.prisma.cskhInboxConversation
        .updateMany({
          where: { id: { in: toClearAwaiting } },
          data: { awaitingLabel: false },
        })
        .catch((e) => {
          this.logger.warn(
            `correctUnreadFromLastMessage awaitingLabel clear failed: ${(e as Error).message}`,
          );
        });
    }

    return result;
  }

  private async loadConversationMessages(
    conversationId: string,
    sinceDate: Date | undefined,
    fetchLimit: number,
  ) {
    const hasSince = sinceDate && !Number.isNaN(sinceDate.getTime());
    if (hasSince) {
      return this.prisma.cskhInboxMessage.findMany({
        where: { conversationId, sentAt: { gt: sinceDate! } },
        orderBy: { sentAt: 'asc' },
        take: 100,
        select: INBOX_MESSAGE_SELECT,
      });
    }
    const rows = await this.prisma.cskhInboxMessage.findMany({
      where: { conversationId },
      orderBy: { sentAt: 'desc' },
      take: fetchLimit,
      select: INBOX_MESSAGE_SELECT,
    });
    return rows.reverse();
  }

  private async enrichCustomerPictures(conversationIds: string[]) {
    const convs = await this.prisma.cskhInboxConversation.findMany({
      where: { id: { in: conversationIds } },
    });
    await Promise.all(
      convs.map(async (conv) => {
        const config = await this.prisma.facebookCskhConfig.findUnique({
          where: { pageId: conv.pageId },
        });
        if (!config?.pageAccessToken) return;
        try {
          const profile = await this.graph.getMessengerUserProfile(
            conv.participantPsid,
            config.pageAccessToken,
          );
          if (!profile.pictureUrl && !profile.name) return;
          const updatedConv = await this.prisma.cskhInboxConversation.update({
            where: { id: conv.id },
            data: {
              customerName: profile.name ?? undefined,
              customerPictureUrl: profile.pictureUrl ?? undefined,
            },
          });
          this.realtime.publish({
            type: 'conversation',
            conversationId: conv.id,
            pageId: conv.pageId,
            conversation: this.formatConversationRow(updatedConv),
            tenantId: conv.tenantId || undefined,
          });
        } catch (e) {
          this.logger.warn(`Failed to enrich picture for conv ${conv.id}: ${(e as Error).message}`);
        }
      }),
    );
  }

  private async enrichNewConversationProfile(
    conversationId: string,
    customerPsid: string,
    pageAccessToken: string,
  ) {
    try {
      const profile = await this.graph.getMessengerUserProfile(customerPsid, pageAccessToken);
      if (!profile.name && !profile.pictureUrl) return;
      const updatedConv = await this.prisma.cskhInboxConversation.update({
        where: { id: conversationId },
        data: {
          customerName: profile.name ?? undefined,
          customerPictureUrl: profile.pictureUrl ?? undefined,
        },
      });
      this.realtime.publish({
        type: 'conversation',
        conversationId,
        pageId: updatedConv.pageId,
        conversation: this.formatConversationRow(updatedConv),
        tenantId: updatedConv.tenantId || undefined,
      });
    } catch (e) {
      this.logger.debug(`Background profile fetch failed for ${customerPsid}: ${(e as Error).message}`);
    }
  }

  async getMessages(
    conversationId: string,
    since?: string,
    forceRefresh = false,
    limit?: number,
    tenantId?: string,
    viewerUserId?: number,
  ) {
    this.touchUserActivity();

    const fetchLimit = limit
      ? Math.min(Math.max(Math.floor(limit), 10), this.auditRecheckMsgLimit)
      : this.msgLimit;

    const sinceDate = since ? new Date(since) : undefined;

    const labelsPromise = this.inboxLabels
      .getLabelsForConversation(conversationId)
      .catch((e) => {
        if (this.isInboxSchemaMigrationError(e) || isPrismaPoolTimeout(e)) return [] as InboxLabelDto[];
        throw e;
      });

    let conv: Awaited<ReturnType<typeof findInboxConversationById>> = null;
    let messages: Awaited<ReturnType<typeof this.loadConversationMessages>> = [];

    try {
      [conv, messages] = await Promise.all([
        findInboxConversationById(this.prisma, conversationId, tenantId),
        this.loadConversationMessages(conversationId, sinceDate, fetchLimit),
      ]);
    } catch (e) {
      if (isPrismaPoolTimeout(e)) {
        this.logger.warn(
          `getMessages pool busy conv=${conversationId.slice(0, 8)} — retry messages`,
        );
        conv = await findInboxConversationById(this.prisma, conversationId, tenantId).catch(
          () => null,
        );
        messages = conv
          ? await this.loadConversationMessages(conversationId, sinceDate, fetchLimit).catch(
              () => [],
            )
          : [];
      } else {
        throw e;
      }
    }

    if (!conv) throw new NotFoundException('Hội thoại không tồn tại hoặc không có quyền');

    const hasSince = sinceDate && !Number.isNaN(sinceDate.getTime());
    if (!hasSince && conv.fbConversationId && conv.participantPsid) {
      const previewMismatch = lastMessagePreviewMismatch(conv.lastMessage, messages);
      const needsReconcile =
        previewMismatch ||
        messages.length === 0 ||
        forceRefresh;
      if (needsReconcile) {
        this.lastReconcileRead.set(conversationId, Date.now());
        const reconcileTask = this.syncReconcileConversationMessages(
          conv,
          fetchLimit,
          tenantId,
        );
        if (messages.length === 0 || previewMismatch) {
          await reconcileTask;
          messages = await this.loadConversationMessages(conversationId, sinceDate, fetchLimit);
        } else {
          void reconcileTask.catch((e) => {
            this.logger.debug(
              `getMessages reconcile background conv=${conversationId.slice(0, 8)}: ${(e as Error).message}`,
            );
          });
        }
      }

      const lastGraph = this.lastGraphRefresh.get(conversationId) ?? 0;
      const mustAwaitGraph = messages.length === 0 || previewMismatch;
      const shouldGraphRefresh = forceRefresh || mustAwaitGraph;

      if (shouldGraphRefresh) {
        this.lastGraphRefresh.set(conversationId, Date.now());
        const config = await this.prisma.facebookCskhConfig.findUnique({
          where: { pageId: conv.pageId },
          select: { pageAccessToken: true },
        });
        if (config?.pageAccessToken) {
          const refreshTask = this.refreshConversationMessages(
            conv.id,
            conv.pageId,
            conv.fbConversationId!,
            config.pageAccessToken,
            fetchLimit,
            tenantId,
            { bypassHotGuard: mustAwaitGraph || forceRefresh },
          );
          if (mustAwaitGraph) {
            await refreshTask;
            messages = await this.loadConversationMessages(
              conversationId,
              sinceDate,
              fetchLimit,
            );
          } else {
            void refreshTask.catch((e) => {
              this.logger.warn(
                `getMessages background sync failed conv=${conversationId.slice(0, 8)}: ${(e as Error).message}`,
              );
            });
          }
        }
      }
    }

    let labels: InboxLabelDto[] = [];
    try {
      labels = await labelsPromise;
    } catch {
      labels = [];
    }

    const hasLabels = labels.length > 0;
    const customerWaiting = !hasLabels && customerWaitingFromMessages(messages, conv.lastMessage);
    const awaitingLabel = customerWaiting;

    if (viewerUserId) {
      this.inboxLabels.recordConversationViewLite(conversationId, viewerUserId, {
        pageId: conv.pageId,
        tenantId: conv.tenantId,
        hasLabels,
        customerWaiting,
      });
      if (hasLabels) {
        void this.markInboundMessagesRead(conversationId, tenantId).catch((err) => {
          this.logger.warn(`getMessages mark inbound read failed: ${(err as Error).message}`);
        });
      }
    } else if (hasLabels) {
      void this.prisma.cskhInboxConversation
        .update({
          where: { id: conversationId },
          data: { unreadCount: 0, awaitingLabel: false },
        })
        .catch((err) => {
          if (this.isInboxSchemaMigrationError(err)) {
            void this.prisma.cskhInboxConversation
              .update({ where: { id: conversationId }, data: { unreadCount: 0 } })
              .catch(() => undefined);
            return;
          }
          this.logger.warn(`getMessages unread reset failed: ${(err as Error).message}`);
        });
    }

    return {
      conversation: {
        ...conv,
        unreadCount: 0,
        awaitingLabel,
        labels,
        viewers: [],
        labelsLocked: hasLabels,
      },
      messages: (messages ?? []).filter((m) => !this.graph.isStoredMessageNoise(m.text)),
    };
  }

  private async markInboundMessagesRead(conversationId: string, tenantId?: string) {
    const where: Prisma.CskhInboxMessageWhereInput = {
      conversationId,
      direction: 'inbound',
      status: { notIn: ['read', 'failed'] },
    };
    if (tenantId) where.tenantId = tenantId;
    return this.prisma.cskhInboxMessage.updateMany({
      where,
      data: { status: 'read' },
    });
  }

  private async refreshConversationMessages(
    conversationId: string,
    pageId: string,
    fbConversationId: string,
    token: string,
    msgLimit = this.msgLimit,
    tenantId?: string,
    options?: { bypassHotGuard?: boolean },
  ) {
    if (!options?.bypassHotGuard && (await this.redisQueue.isInboxHot())) {
      return;
    }
    try {
      const convRow = await this.prisma.cskhInboxConversation.findUnique({
        where: { id: conversationId },
        select: { participantPsid: true },
      });
      const customerPsid = convRow?.participantPsid ?? undefined;

      const safeLimit = Math.min(Math.max(msgLimit, 10), this.auditRecheckMsgLimit);
      const rawMsgs = await this.graph.fetchMessages(fbConversationId, token, safeLimit);
      const ordered = [...rawMsgs].reverse();

      const existing = await this.prisma.cskhInboxMessage.findMany({
        where: { conversationId },
        select: { id: true, text: true },
      });
      
      // Bulk delete noise messages to optimize DB round trips
      const noiseIds = existing
        .filter((row) => this.graph.isStoredMessageNoise(row.text))
        .map((row) => row.id);
      if (noiseIds.length) {
        await this.prisma.cskhInboxMessage.deleteMany({
          where: { id: { in: noiseIds } },
        });
      }

      let lastPreview: string | null = null;
      const concurrency = 2; // Keep low to avoid DB connection pool exhaustion (Supabase pool_size=15)
      for (let i = 0; i < ordered.length; i += concurrency) {
        const batch = ordered.slice(i, i + concurrency);
        const results = await Promise.all(
          batch.map((msg) =>
            this.persistGraphMessage(
              conversationId,
              pageId,
              msg,
              token,
              tenantId,
              customerPsid,
            ),
          ),
        );
        for (const res of results) {
          if (res) lastPreview = res.text;
        }
      }

      await this.linkFbMessageIdsFromGraph(
        conversationId,
        pageId,
        fbConversationId,
        token,
        customerPsid,
      );
      await this.repairLegacyInboxMessages(conversationId, token);
      if (customerPsid) {
        await this.reconcileMessageSenders(conversationId, pageId, customerPsid, rawMsgs);
      }

      if (lastPreview) {
        await this.prisma.cskhInboxConversation.update({
          where: { id: conversationId },
          data: { lastMessage: lastPreview },
        });
      }

      await this.markAdFromGraphMessages(conversationId, rawMsgs);
      await this.markAdFromStoredMessages(conversationId);

      const syncedRows = await this.loadConversationMessages(
        conversationId,
        undefined,
        safeLimit,
      );
      if (syncedRows.length) {
        this.realtime.publish({
          type: 'message',
          pageId,
          conversationId,
          messages: syncedRows.map((m) => this.formatMessageRow(m as CskhInboxMessage)),
          tenantId,
        });
      }
    } catch (e) {
      this.logger.warn(
        `refreshConversationMessages ${conversationId}: ${(e as Error).message}`,
      );
    }
  }

  private looksLikeMediaPlaceholder(row: {
    text: string;
    messageType: string;
    attachmentUrl: string | null;
  }): boolean {
    if (row.attachmentUrl?.startsWith('http')) return false;
    return (
      row.messageType === 'image' ||
      row.messageType === 'video' ||
      row.text === '[Ảnh]' ||
      row.text === '[Video]' ||
      row.text === '[attachment]'
    );
  }

  /** Facebook message IDs luôn bắt đầu bằng 'm_'. UUID nội bộ (dạng xxxxxxxx-xxxx-...) không hợp lệ cho Graph API. */
  private isValidFbMessageId(id: string | null | undefined): boolean {
    if (!id) return false;
    return id.startsWith('m_');
  }

  private needsMediaBackfill(row: {
    text: string;
    attachmentUrl: string | null;
    messageType: string;
    fbMessageId: string | null;
  }): boolean {
    if (row.attachmentUrl?.startsWith('http')) return false;
    if (!this.isValidFbMessageId(row.fbMessageId)) return false;
    return this.looksLikeMediaPlaceholder(row);
  }

  /** Gắn fbMessageId cho tin ảnh cũ (webhook lưu sentAt lệch vài giây so với Graph). */
  private async linkFbMessageIdsFromGraph(
    conversationId: string,
    pageId: string,
    fbConversationId: string,
    token: string,
    customerPsid?: string,
  ) {
    if (await this.redisQueue.isInboxHot()) return;
    const missing = await this.prisma.cskhInboxMessage.findMany({
      where: {
        conversationId,
        fbMessageId: null,
        OR: [
          { text: '[Ảnh]' },
          { text: '[Video]' },
          { text: '[attachment]' },
          { messageType: 'image' },
          { messageType: 'video' },
        ],
      },
      select: { id: true, sentAt: true, senderType: true },
      take: 100,
    });
    if (!missing.length) return;

    const rawMsgs = await this.graph.fetchMessages(fbConversationId, token, this.msgLimit);
    for (const row of missing) {
      const rowTs = row.sentAt.getTime();
      const isStaff = row.senderType === 'staff';
      const match = rawMsgs.find((msg) => {
        const normalized = this.graph.normalizeMessageForInbox(msg, pageId, customerPsid);
        if (!normalized) return false;
        const msgStaff = normalized.sender === 'Staff';
        if (msgStaff !== isStaff) return false;
        const msgTs = msg.created_time ? new Date(msg.created_time).getTime() : 0;
        if (Math.abs(msgTs - rowTs) > 5000) return false;
        return (
          normalized.messageType === 'image' ||
          normalized.messageType === 'video' ||
          normalized.text === '[Ảnh]' ||
          normalized.text === '[Video]' ||
          Boolean(msg.attachments?.data?.length)
        );
      });
      if (match?.id) {
        const fbMessageId = String(match.id);
        const taken = await this.prisma.cskhInboxMessage.findUnique({
          where: { fbMessageId },
          select: { id: true },
        });
        if (taken && taken.id !== row.id) continue;
        try {
          await this.prisma.cskhInboxMessage.update({
            where: { id: row.id },
            data: { fbMessageId },
          });
        } catch (e) {
          this.logger.debug(`linkFbMessageIds skipped duplicate fb_message_id ${fbMessageId}: ${(e as Error).message}`);
        }
      }
    }
  }

  private async backfillMissingMediaUrls<
    T extends {
      id: string;
      text: string;
      attachmentUrl: string | null;
      messageType: string;
      fbMessageId: string | null;
    },
  >(
    pageId: string,
    conversationId: string,
    fbConversationId: string | null,
    rows: T[],
  ): Promise<T[]> {
    const config = await this.getCachedPageConfig(pageId);
    if (!config?.pageAccessToken) return rows;

    if (
      fbConversationId &&
      rows.some((r) => !r.fbMessageId && this.looksLikeMediaPlaceholder(r))
    ) {
      await this.linkFbMessageIdsFromGraph(
        conversationId,
        pageId,
        fbConversationId,
        config.pageAccessToken,
      );
      const linked = await this.prisma.cskhInboxMessage.findMany({
        where: { id: { in: rows.map((r) => r.id) } },
        select: { id: true, fbMessageId: true },
      });
      const byId = new Map(linked.map((r) => [r.id, r.fbMessageId]));
      for (let i = 0; i < rows.length; i++) {
        const fbId = byId.get(rows[i].id);
        if (fbId) rows[i] = { ...rows[i], fbMessageId: fbId };
      }
    }

    const result = [...rows];
    const batchSize = 40;
    for (let round = 0; round < 3; round++) {
      const missing = result.filter((r) => this.needsMediaBackfill(r)).slice(0, batchSize);
      if (!missing.length) break;
      let progress = false;
      await Promise.all(
        missing.map(async (row) => {
          try {
            const resolved = await this.graph.resolveMessageMediaUrl(
              row.fbMessageId!,
              config.pageAccessToken,
            );
            if (!resolved.url) return;
            progress = true;
            const newText =
              row.text === '[Ảnh]' || row.text === '[attachment]' ? '' : row.text;
            const updated = await this.prisma.cskhInboxMessage.update({
              where: { id: row.id },
              data: {
                attachmentUrl: resolved.url,
                messageType: resolved.messageType ?? row.messageType,
                text: newText,
              },
            });
            const idx = result.findIndex((r) => r.id === row.id);
            if (idx >= 0) {
              result[idx] = {
                ...result[idx],
                attachmentUrl: resolved.url,
                messageType: resolved.messageType ?? row.messageType,
                text: newText,
              };
            }
            // Phát sóng SSE cập nhật media thời gian thực cho FE hiển thị hình ảnh ngay khi vừa resolve xong
            this.publishMessageRealtime(pageId, conversationId, [updated]);
          } catch (e) {
            this.logger.warn(`Failed to resolve media URL for message ${row.id}: ${(e as Error).message}`);
          }
        }),
      );
      if (!progress) break;
    }
    return result;
  }

  private async repairLegacyInboxMessages(conversationId: string, token?: string) {
    const rows = await this.prisma.cskhInboxMessage.findMany({
      where: { conversationId },
      select: {
        id: true,
        text: true,
        attachmentUrl: true,
        messageType: true,
        fbMessageId: true,
      },
    });

    if (token) {
      const pageId = (
        await this.prisma.cskhInboxConversation.findUnique({
          where: { id: conversationId },
          select: { pageId: true },
        })
      )?.pageId;
      if (pageId) {
        await this.backfillMissingMediaUrls(
          pageId,
          conversationId,
          (
            await this.prisma.cskhInboxConversation.findUnique({
              where: { id: conversationId },
              select: { fbConversationId: true },
            })
          )?.fbConversationId ?? null,
          rows,
        );
      }
    }

    const fresh = await this.prisma.cskhInboxMessage.findMany({
      where: { conversationId },
      select: { id: true, text: true, attachmentUrl: true, messageType: true },
    });
    for (const row of fresh) {
      const repaired = repairStoredMessage(row.text, row.attachmentUrl, row.messageType);
      if (!repaired.changed) continue;
      await this.prisma.cskhInboxMessage.update({
        where: { id: row.id },
        data: {
          text: repaired.text,
          attachmentUrl: repaired.attachmentUrl,
          messageType: repaired.messageType,
        },
      });
    }
  }

  private async persistGraphMessage(
    conversationId: string,
    pageId: string,
    msg: FbMessage,
    token?: string,
    tenantId?: string,
    customerPsid?: string,
  ): Promise<{ text: string } | null> {
    let enriched = msg;
    if (token) {
      enriched = await this.graph.enrichMessageWithMedia(msg, token);
    }
    let normalized = this.graph.normalizeMessageForInbox(enriched, pageId, customerPsid);
    if (!normalized) return null;

    const attCount = enriched.attachments?.data?.length ?? 0;
    const needsResolve =
      token &&
      enriched.id &&
      (attCount > 1 ||
        !normalized.attachmentUrl ||
        (normalized.attachmentUrls?.length ?? 0) < attCount);
    if (needsResolve) {
      const looksLikeMedia =
        normalized.messageType === 'image' ||
        normalized.messageType === 'video' ||
        normalized.text === '[Ảnh]' ||
        normalized.text === '[Video]' ||
        attCount > 0;
      if (looksLikeMedia) {
        const resolvedAll = await this.graph.resolveAllMessageMediaUrls(enriched.id!, token!);
        if (resolvedAll.length) {
          const urls = dedupeMediaUrls(resolvedAll.map((r) => r.url));
          normalized = {
            ...normalized,
            attachmentUrls: urls,
            attachmentUrl: urls[0] ?? null,
            messageType: resolvedAll[0].messageType ?? normalized.messageType,
            text:
              urls.length > 1 && resolvedAll[0].messageType === 'image'
                ? normalized.text === '[Ảnh]'
                  ? ''
                  : normalized.text
                : resolvedAll[0].messageType === 'video'
                  ? ''
                  : normalized.text === '[Ảnh]'
                    ? ''
                    : normalized.text,
          };
        }
      }
    }

    const sentAt = msg.created_time ? new Date(msg.created_time) : new Date();
    const isStaff = normalized.sender === 'Staff';
    const senderType = isStaff ? 'staff' : 'customer';
    const direction = isStaff ? 'outbound' : 'inbound';
    const fbMessageId = msg.id ? String(msg.id) : null;
    const mediaUrls =
      dedupeMediaUrls(
        normalized.attachmentUrls?.length
          ? normalized.attachmentUrls
          : normalized.attachmentUrl
            ? [normalized.attachmentUrl]
            : [],
      );

    if (!mediaUrls.length) {
      let exists = fbMessageId
        ? await this.prisma.cskhInboxMessage.findUnique({ where: { fbMessageId } })
        : null;
      if (!exists) {
        exists = await this.findStoredMessageNearSentAt(
          conversationId,
          sentAt,
          isStaff,
          normalized.text,
        );
      }
      const payload = {
        text: normalized.text,
        messageType: normalized.messageType,
        attachmentUrl: null as string | null,
      };
      if (exists) {
        const needsSenderFix =
          exists.senderType !== senderType || exists.direction !== direction;
        const needsUpdate =
          needsSenderFix ||
          exists.text !== payload.text ||
          exists.messageType !== payload.messageType ||
          (fbMessageId && !exists.fbMessageId);
        if (needsUpdate) {
          try {
            await this.prisma.cskhInboxMessage.update({
              where: { id: exists.id },
              data: {
                ...payload,
                senderType,
                direction,
                ...(fbMessageId && !exists.fbMessageId ? { fbMessageId } : {}),
              },
            });
          } catch (e) {
            this.logger.debug(`Failed to update legacy message ${exists.id} with fbMessageId ${fbMessageId}: ${(e as Error).message}`);
            if (fbMessageId && !exists.fbMessageId) {
              try {
                await this.prisma.cskhInboxMessage.update({
                  where: { id: exists.id },
                  data: { ...payload, senderType, direction },
                });
              } catch (retryErr) {
                this.logger.error(`Retry update legacy message ${exists.id} failed: ${(retryErr as Error).message}`);
              }
            }
          }
        }
        return { text: normalized.text };
      }
      await this.prisma.cskhInboxMessage.create({
        data: {
          conversationId,
          direction,
          senderType,
          fbMessageId,
          ...payload,
          sentAt,
          status: 'sent',
          tenantId,
        },
      });
      return { text: normalized.text };
    }

    for (let i = 0; i < mediaUrls.length; i++) {
      const attachmentUrl = mediaUrls[i];
      const rowFbMessageId = i === 0 ? fbMessageId : null;
      const rowText =
        i === 0
          ? normalized.text
          : normalized.messageType === 'image' || normalized.messageType === 'video'
            ? ''
            : normalized.text;
      const payload = {
        text: rowText,
        messageType: normalized.messageType,
        attachmentUrl,
      };

      let exists = rowFbMessageId
        ? await this.prisma.cskhInboxMessage.findUnique({ where: { fbMessageId: rowFbMessageId } })
        : null;
      if (!exists && attachmentUrl) {
        exists = await this.prisma.cskhInboxMessage.findFirst({
          where: {
            conversationId,
            senderType: isStaff ? 'staff' : 'customer',
            attachmentUrl,
            sentAt: {
              gte: new Date(sentAt.getTime() - 2000),
              lte: new Date(sentAt.getTime() + 2000),
            },
          },
        });
      }
      if (!exists && i === 0) {
        exists = await this.findStoredMessageNearSentAt(
          conversationId,
          sentAt,
          isStaff,
          normalized.text,
        );
      }

      if (exists) {
        const needsSenderFix =
          exists.senderType !== senderType || exists.direction !== direction;
        const needsUpdate =
          needsSenderFix ||
          exists.text !== payload.text ||
          exists.messageType !== payload.messageType ||
          (exists.attachmentUrl ?? null) !== attachmentUrl ||
          (rowFbMessageId && !exists.fbMessageId) ||
          (!exists.attachmentUrl && attachmentUrl);
        if (needsUpdate) {
          try {
            await this.prisma.cskhInboxMessage.update({
              where: { id: exists.id },
              data: {
                ...payload,
                senderType,
                direction,
                ...(rowFbMessageId && !exists.fbMessageId ? { fbMessageId: rowFbMessageId } : {}),
              },
            });
          } catch (e) {
            this.logger.debug(`Failed to update message ${exists.id} with fbMessageId ${rowFbMessageId}: ${(e as Error).message}`);
            if (rowFbMessageId && !exists.fbMessageId) {
              try {
                await this.prisma.cskhInboxMessage.update({
                  where: { id: exists.id },
                  data: { ...payload, senderType, direction },
                });
              } catch (retryErr) {
                this.logger.error(`Retry update message ${exists.id} failed: ${(retryErr as Error).message}`);
              }
            }
          }
        }
        continue;
      }

      await this.prisma.cskhInboxMessage.create({
        data: {
          conversationId,
          direction,
          senderType,
          fbMessageId: rowFbMessageId,
          ...payload,
          sentAt,
          status: 'sent',
          tenantId,
        },
      });
    }

    return { text: normalized.text };
  }

  private findStoredMessageNearSentAt(
    conversationId: string,
    sentAt: Date,
    isStaff: boolean,
    text?: string,
  ) {
    const windowMs = 5000;
    const sentWindow = {
      gte: new Date(sentAt.getTime() - windowMs),
      lte: new Date(sentAt.getTime() + windowMs),
    };
    const bySender = this.prisma.cskhInboxMessage.findFirst({
      where: {
        conversationId,
        senderType: isStaff ? 'staff' : 'customer',
        sentAt: sentWindow,
      },
      orderBy: { sentAt: 'asc' },
    });
    if (!text?.trim()) return bySender;
    return bySender.then((hit) => {
      if (hit) return hit;
      return this.prisma.cskhInboxMessage.findFirst({
        where: {
          conversationId,
          text: text.trim(),
          sentAt: sentWindow,
        },
        orderBy: { sentAt: 'asc' },
      });
    });
  }

  /** Lazy resolve URL ảnh/video cho một tin (FE gọi khi vẫn thấy [Ảnh]). */
  async resolveInboxMessageMedia(messageId: string) {
    const row = await this.prisma.cskhInboxMessage.findUnique({
      where: { id: messageId },
      include: { conversation: true },
    });
    if (!row) throw new NotFoundException('Tin nhắn không tồn tại');

    if (row.attachmentUrl?.startsWith('http')) {
      const siblings = await this.prisma.cskhInboxMessage.findMany({
        where: {
          conversationId: row.conversationId,
          senderType: row.senderType,
          attachmentUrl: { startsWith: 'http' },
          sentAt: {
            gte: new Date(row.sentAt.getTime() - 2000),
            lte: new Date(row.sentAt.getTime() + 2000),
          },
        },
        orderBy: { sentAt: 'asc' },
        select: { attachmentUrl: true },
      });
      const attachmentUrls = dedupeMediaUrls(siblings.map((s) => s.attachmentUrl));
      return {
        id: row.id,
        attachmentUrl: row.attachmentUrl,
        attachmentUrls: attachmentUrls.length > 1 ? attachmentUrls : undefined,
        messageType: row.messageType,
        text: row.text,
      };
    }

    const config = await this.prisma.facebookCskhConfig.findUnique({
      where: { pageId: row.conversation.pageId },
    });
    if (!config?.pageAccessToken) {
      throw new BadRequestException('Page chưa có access token');
    }

    let fbMessageId = row.fbMessageId;
    if (
      !fbMessageId &&
      row.conversation.fbConversationId &&
      this.looksLikeMediaPlaceholder(row)
    ) {
      await this.linkFbMessageIdsFromGraph(
        row.conversationId,
        row.conversation.pageId,
        row.conversation.fbConversationId,
        config.pageAccessToken,
      );
      const linked = await this.prisma.cskhInboxMessage.findUnique({
        where: { id: messageId },
        select: { fbMessageId: true },
      });
      fbMessageId = linked?.fbMessageId ?? null;
    }

    if (!fbMessageId) {
      return {
        id: row.id,
        attachmentUrl: null,
        messageType: row.messageType,
        text: row.text,
      };
    }

    const resolvedAll = await this.graph.resolveAllMessageMediaUrls(
      fbMessageId,
      config.pageAccessToken,
    );
    if (!resolvedAll.length) {
      return {
        id: row.id,
        attachmentUrl: null,
        messageType: row.messageType,
        text: row.text,
      };
    }

    const text =
      row.text === '[Ảnh]' || row.text === '[attachment]' ? '' : row.text;
    const primary = resolvedAll[0];
    await this.prisma.cskhInboxMessage.update({
      where: { id: messageId },
      data: {
        attachmentUrl: primary.url,
        messageType: primary.messageType ?? row.messageType,
        text,
      },
    });

    for (let i = 1; i < resolvedAll.length; i++) {
      const item = resolvedAll[i];
      const exists = await this.prisma.cskhInboxMessage.findFirst({
        where: {
          conversationId: row.conversationId,
          senderType: row.senderType,
          attachmentUrl: item.url,
          sentAt: {
            gte: new Date(row.sentAt.getTime() - 2000),
            lte: new Date(row.sentAt.getTime() + 2000),
          },
        },
      });
      if (exists) continue;
      await this.prisma.cskhInboxMessage.create({
        data: {
          conversationId: row.conversationId,
          direction: row.direction,
          senderType: row.senderType,
          text: '',
          messageType: item.messageType,
          attachmentUrl: item.url,
          sentAt: row.sentAt,
          status: 'sent',
        },
      });
    }

    const attachmentUrls = dedupeMediaUrls(resolvedAll.map((r) => r.url));
    return {
      id: row.id,
      attachmentUrl: primary.url,
      attachmentUrls: attachmentUrls.length > 1 ? attachmentUrls : undefined,
      messageType: primary.messageType ?? row.messageType,
      text,
    };
  }

  async sendMessage(conversationId: string, text: string, tenantId?: string) {
    const trimmed = text.trim();
    if (!trimmed) throw new BadRequestException('Tin nhắn trống');

    const conv = await findInboxConversationById(this.prisma, conversationId, tenantId);
    if (!conv) throw new NotFoundException('Hội thoại không tồn tại hoặc không có quyền');

    const config = await this.prisma.facebookCskhConfig.findFirst({
      where: tenantId ? { pageId: conv.pageId, tenantId } : { pageId: conv.pageId },
    });
    if (!config?.pageAccessToken) {
      throw new BadRequestException('Page chưa có access token');
    }

    const pending = await this.prisma.cskhInboxMessage.create({
      data: {
        conversationId: conv.id,
        direction: 'outbound',
        senderType: 'staff',
        text: trimmed,
        status: 'pending',
        tenantId,
      },
    });

    const updatedConv = await this.prisma.cskhInboxConversation.update({
      where: { id: conv.id },
      data: {
        lastMessage: trimmed,
        lastMessageAt: new Date(),
        unreadCount: 0,
        awaitingLabel: false,
      },
    });

    // 1. Publish pending message and updated conversation to SSE immediately
    this.publishMessageRealtime(conv.pageId, conv.id, [pending], false, tenantId, updatedConv);

    // 2. Perform the Meta Graph API sending in the background
    void (async () => {
      try {
        const result = await this.graph.sendPageMessage(
          conv.pageId,
          config.pageAccessToken,
          conv.participantPsid,
          trimmed,
        );
        const sent = await this.prisma.cskhInboxMessage.update({
          where: { id: pending.id },
          data: {
            status: 'sent',
            fbMessageId: result.message_id ?? null,
          },
        });
        this.publishMessageRealtime(conv.pageId, conv.id, [sent], false, tenantId, updatedConv);
      } catch (e) {
        this.logger.error(`Failed to send message to Facebook background for msg ${pending.id}: ${(e as Error).message}`);
        const failed = await this.prisma.cskhInboxMessage.update({
          where: { id: pending.id },
          data: { status: 'failed' },
        });
        this.publishMessageRealtime(conv.pageId, conv.id, [failed], false, tenantId, updatedConv);
      }
    })();

    // 3. Return the pending message immediately to caller
    return pending;
  }

  /** Broadcast typing indicator event qua SSE. */
  async notifyTyping(conversationId: string, tenantId?: string) {
    const conv = await findInboxConversationById(this.prisma, conversationId, tenantId);
    if (!conv) throw new NotFoundException('Hội thoại không tồn tại hoặc không có quyền');

    const config = await this.prisma.facebookCskhConfig.findFirst({
      where: tenantId ? { pageId: conv.pageId, tenantId } : { pageId: conv.pageId },
    });
    if (config?.pageAccessToken) {
      void this.graph.sendPageSenderAction(
        conv.pageId,
        config.pageAccessToken,
        conv.participantPsid,
        'typing_on',
      );
    }

    this.realtime.publish({
      type: 'typing',
      conversationId,
      pageId: conv.pageId,
      tenantId: conv.tenantId || undefined,
    });
  }

  /** Đánh dấu đã đọc — chỉ khi đã gán nhãn; nếu chưa gán nhãn thì ghi nhận xem và giữ chờ xử lý. */
  async markAsRead(conversationId: string, tenantId?: string, viewerUserId?: number) {
    if (viewerUserId) {
      const viewed = await this.inboxLabels.recordConversationView(
        conversationId,
        viewerUserId,
        tenantId,
      );
      const conv = viewed.conversation;
      const labels = viewed.labels;

      if (labels.length === 0) {
        this.realtime.publish({
          type: 'conversation',
          pageId: conv.pageId,
          conversationId: conv.id,
          conversation: {
            ...this.formatConversationRow(conv),
            labels,
            viewers: viewed.viewers,
            labelsLocked: false,
          },
          tenantId: conv.tenantId || undefined,
        });
        return { markedAsRead: 0, awaitingLabel: true };
      }
    }

    const conv = await findInboxConversationById(this.prisma, conversationId, tenantId);
    if (!conv) throw new NotFoundException('Hội thoại không tồn tại hoặc không có quyền');

    const labels = await this.inboxLabels.getLabelsForConversation(conversationId);
    if (labels.length === 0) {
      throw new BadRequestException('Phải gán nhãn trước khi đánh dấu đã đọc');
    }

    const config = await this.prisma.facebookCskhConfig.findFirst({
      where: tenantId ? { pageId: conv.pageId, tenantId } : { pageId: conv.pageId },
    });
    if (config?.pageAccessToken) {
      void this.graph.sendPageSenderAction(
        conv.pageId,
        config.pageAccessToken,
        conv.participantPsid,
        'mark_seen',
      );
    }

    const updatedConv = await this.prisma.cskhInboxConversation.update({
      where: { id: conversationId },
      data: { unreadCount: 0, awaitingLabel: false },
    });

    const updated = await this.markInboundMessagesRead(conversationId, tenantId);

    this.realtime.publish({
      type: 'read-receipt',
      conversationId,
      pageId: conv.pageId,
      conversation: this.formatConversationRow(updatedConv),
      tenantId: conv.tenantId || undefined,
    });

    return { markedAsRead: updated.count };
  }

  /**
   * Đồng bộ inbox từ Graph API (khi chưa có webhook hoặc refresh).
   * options.full = true → quét ĐẦY ĐỦ: lấy hết hội thoại và hết tin nhắn mỗi hội thoại
   * (dùng để backfill dữ liệu cũ cho page mới kết nối). Nếu không, dùng giới hạn nhẹ.
   */
  async syncFromGraph(
    pageId?: string,
    tenantId?: string,
    options?: { full?: boolean; lightweight?: boolean },
  ) {
    if (await this.redisQueue.isInboxHot()) {
      this.logger.log('[syncFromGraph] Bỏ qua — inbox/webhook đang ưu tiên');
      return { synced: 0, pageCount: 0, okPages: 0, failedPages: [] as Array<{ page: string; error: string }> };
    }
    if (this.graphCoordinator.inboxSyncActive) {
      this.logger.log('[syncFromGraph] Bỏ qua — đang sync inbox');
      return { synced: 0, pageCount: 0, okPages: 0, failedPages: [] as Array<{ page: string; error: string }> };
    }
    this.graphCoordinator.beginInboxSync();
    await this.redisQueue.markInboxSyncActive();
    try {
      return await this.syncFromGraphInner(pageId, tenantId, options);
    } finally {
      this.graphCoordinator.endInboxSync();
      await this.redisQueue.clearInboxSyncActive();
    }
  }

  private async syncFromGraphInner(
    pageId?: string,
    tenantId?: string,
    options?: { full?: boolean; lightweight?: boolean },
  ) {
    const full = options?.full === true;
    const lightweight = options?.lightweight === true;
    const where: any = {};
    if (pageId) where.pageId = pageId;
    if (tenantId) where.tenantId = tenantId;
    const pages = await this.prisma.facebookCskhConfig.findMany({ where });

    let synced = 0;
    let okPages = 0;
    const failedPages: Array<{ page: string; error: string }> = [];
    for (const page of pages) {
      if (await this.redisQueue.isInboxHot()) {
        this.logger.log('[syncFromGraph] Dừng giữa chừng — nhường webhook/inbox');
        break;
      }
      await this.redisQueue.markInboxSyncActive();
      // Cô lập lỗi theo từng page: 1 page lỗi (rate limit, token hỏng, Graph 500…)
      // KHÔNG được làm dừng việc quét các page còn lại.
      try {
        synced += await this.syncSinglePageFromGraph(page, full, lightweight);
        okPages++;
      } catch (e) {
        const msg = (e as Error).message;
        failedPages.push({ page: page.pageName || page.pageId, error: msg });
        this.logger.error(
          `[syncFromGraph${full ? ':full' : ''}] LỖI page ${page.pageName || page.pageId}: ${msg}`,
        );
      }
    }
    if (failedPages.length) {
      this.logger.warn(
        `[syncFromGraph${full ? ':full' : ''}] Hoàn tất với ${failedPages.length}/${pages.length} page lỗi: ` +
          failedPages.map((f) => f.page).join(', '),
      );
    }
    return { synced, pageCount: pages.length, okPages, failedPages };
  }

  /**
   * Ghi nhanh tin nhắn để ĐẾM (lightweight): không gọi Graph để enrich media/ảnh,
   * dựng row trực tiếp từ dữ liệu đã có rồi insert hàng loạt. Dùng cho backfill.
   * Trả về số tin thực sự được thêm mới.
   */
  private async fastPersistMessages(
    conversationId: string,
    pageId: string,
    rawMsgs: FbMessage[],
    tenantId?: string | null,
    customerPsid?: string,
  ): Promise<number> {
    if (!rawMsgs.length) return 0;
    const data: Array<{
      conversationId: string;
      fbMessageId: string | null;
      direction: string;
      senderType: string;
      text: string;
      messageType: string;
      attachmentUrl: string | null;
      sentAt: Date;
      status: string;
      tenantId: string | null;
    }> = [];
    for (const msg of rawMsgs) {
      const n = this.graph.normalizeMessageForInbox(msg, pageId, customerPsid);
      if (!n) continue;
      const isStaff = n.sender === 'Staff';
      data.push({
        conversationId,
        fbMessageId: msg.id ? String(msg.id) : null,
        direction: isStaff ? 'outbound' : 'inbound',
        senderType: isStaff ? 'staff' : 'customer',
        text: n.text,
        messageType: n.messageType,
        attachmentUrl: n.attachmentUrl ?? null,
        sentAt: msg.created_time ? new Date(msg.created_time) : new Date(),
        status: 'sent',
        tenantId: tenantId ?? null,
      });
    }
    if (!data.length) return 0;
    // skipDuplicates dựa trên unique fbMessageId → chạy lại an toàn cho tin có fbMessageId.
    const res = await this.prisma.cskhInboxMessage.createMany({ data, skipDuplicates: true });
    return res.count;
  }

  /** Sửa senderType/direction sai trong DB khi quét lại (tin page bị gán nhầm thành khách). */
  private async syncReconcileConversationMessages(
    conv: {
      id: string;
      pageId: string;
      fbConversationId: string | null;
      participantPsid: string | null;
    },
    msgLimit: number,
    tenantId?: string,
  ): Promise<void> {
    if (!conv.fbConversationId || !conv.participantPsid) return;
    if (await this.redisQueue.isInboxHot()) return;

    const config = await this.prisma.facebookCskhConfig.findUnique({
      where: { pageId: conv.pageId },
      select: { pageAccessToken: true },
    });
    if (!config?.pageAccessToken) return;

    try {
      const safeLimit = Math.min(Math.max(msgLimit, 10), this.msgLimit);
      const rawMsgs = await this.graph.fetchMessages(
        conv.fbConversationId,
        config.pageAccessToken,
        safeLimit,
      );
      await this.reconcileMessageSenders(
        conv.id,
        conv.pageId,
        conv.participantPsid,
        rawMsgs,
      );
    } catch (e) {
      this.logger.debug(
        `syncReconcileConversationMessages ${conv.id}: ${(e as Error).message}`,
      );
    }
  }

  private async reconcileMessageSenders(
    conversationId: string,
    pageId: string,
    customerPsid: string,
    rawMsgs: FbMessage[],
  ) {
    for (const msg of rawMsgs) {
      if (!msg.id) continue;
      const n = this.graph.normalizeMessageForInbox(msg, pageId, customerPsid);
      if (!n) continue;
      const senderType = n.sender === 'Staff' ? 'staff' : 'customer';
      const direction = n.sender === 'Staff' ? 'outbound' : 'inbound';
      await this.prisma.cskhInboxMessage.updateMany({
        where: { fbMessageId: String(msg.id), conversationId },
        data: { senderType, direction },
      });
    }
  }

  /** Trạng thái tiến trình quét đầy đủ (cho FE poll hiển thị thanh tiến độ). */
  async getBackfillStatus(tenantId?: string) {
    const runningJob = await this.findRunningBackfillJob(tenantId);
    if (runningJob) {
      return this.backfillStatusFromJob(runningJob, { running: true, paused: false });
    }
    const pausedJob = await this.findPausedBackfillJob(tenantId);
    if (pausedJob) {
      return this.backfillStatusFromJob(pausedJob, { running: false, paused: true });
    }
    const recentJob = await this.findRecentBackfillJob(tenantId);
    if (recentJob) {
      return this.backfillStatusFromJob(recentJob, { running: false, paused: false });
    }
    return this.toBackfillResponse();
  }

  /** Yêu cầu tạm dừng — lưu tiến độ sau khi xong kênh hiện tại. */
  async requestBackfillPause() {
    const runningJob = await this.findRunningBackfillJob();
    if (!runningJob && !this.backfillState.running) {
      return { paused: false, message: 'Không có tiến trình quét đang chạy' };
    }
    const jobId = runningJob?.id ?? this.backfillJobId;
    if (jobId) {
      await this.redisQueue.setBackfillPauseRequested(jobId);
      await this.markBackfillPauseRequestedInDb(jobId);
    }
    this.backfillPauseRequested = true;
    return { paused: true };
  }

  /**
   * Hủy toàn bộ quét đang chạy / đang chờ — dừng ngay, xóa hàng đợi Redis, đánh dấu job cancelled.
   */
  async cancelAllBackfill(tenantId?: string) {
    const where: { type: string; status: { in: string[] }; tenantId?: string } = {
      type: 'inbox-backfill',
      status: { in: ['running', 'paused'] },
    };
    if (tenantId) where.tenantId = tenantId;

    const jobs = await this.prisma.cskhJobRun.findMany({ where, select: { id: true } });

    this.backfillCancelRequested = true;

    for (const job of jobs) {
      await this.redisQueue.setBackfillCancelRequested(job.id);
    }

    const cancelled = await this.prisma.cskhJobRun.updateMany({
      where,
      data: { status: 'cancelled', finishedAt: new Date() },
    });

    const queueCleared = await this.redisQueue.purgeBackfillQueue();

    for (const job of jobs) {
      await this.redisQueue.clearBackfillPauseRequested(job.id);
    }
    if (this.backfillJobId) {
      await this.redisQueue.clearBackfillCancelRequested(this.backfillJobId);
    }

    this.backfillState = {
      running: false,
      paused: false,
      scope: '',
      total: 0,
      done: 0,
      currentPage: null,
      pageConvsDone: 0,
      addedMessages: 0,
      okPages: 0,
      errorPages: [],
      startedAt: null,
      finishedAt: new Date().toISOString(),
      jobId: null,
    };
    this.backfillJobId = null;
    this.backfillTenantId = undefined;
    this.backfillCompletedPageIds = [];
    this.backfillCancelRequested = false;
    this.backfillPauseRequested = false;
    this.stopBackfillPausePoller();

    const count = cancelled.count;
    this.logger.log(
      `[backfill] cancelAll: ${count} job DB, ${queueCleared} item hàng đợi`,
    );

    return {
      cancelled: count,
      queueCleared,
      message:
        count > 0 || queueCleared > 0
          ? `Đã hủy ${count} job quét${queueCleared > 0 ? `, xóa ${queueCleared} job trong hàng đợi` : ''}`
          : 'Không có job quét đang chạy',
    };
  }

  /**
   * Bắt đầu / tiếp tục "Quét đầy đủ" — xếp hàng Redis, worker thực thi (tách khỏi API inbox).
   * Nếu có job paused trong DB → tự bỏ qua các kênh đã quét.
   * force=true → quét lại từ đầu, bỏ qua tiến độ cũ.
   */
  async startBackfill(
    scope: 'empty' | 'all',
    tenantId?: string,
    options?: { force?: boolean },
  ) {
    const runningJob = await this.findRunningBackfillJob(tenantId);
    if (runningJob) {
      return this.backfillStatusFromJob(runningJob, { running: true, paused: false });
    }
    if (this.backfillState.running) return this.toBackfillResponse();

    this.backfillTenantId = tenantId;
    this.backfillPauseRequested = false;
    this.backfillCancelRequested = false;

    let completedPageIds: string[] = [];
    let resumeFromJob = false;
    let initialDone = 0;
    let initialAdded = 0;
    let initialOk = 0;
    let initialErrors: Array<{ page: string; error: string; pageId?: string }> = [];
    let totalAllPages = 0;

    const tenantFilter = tenantId
      ? Prisma.sql`AND cfg.tenant_id = ${tenantId}::uuid`
      : Prisma.empty;

    const allPages = await this.prisma.$queryRaw<Array<{ pageId: string; pageName: string | null }>>`
      SELECT cfg.page_id AS "pageId", cfg.page_name AS "pageName"
      FROM facebook_cskh_configs cfg
      WHERE cfg.page_access_token IS NOT NULL AND cfg.page_access_token <> ''
      ${tenantFilter}
      ORDER BY cfg.page_name ASC
    `;
    totalAllPages = allPages.length;

    const pausedJob = options?.force ? null : await this.findPausedBackfillJob(tenantId);
    if (pausedJob) {
      const parsed = this.jobSummaryToState(pausedJob.summary as Record<string, unknown>);
      completedPageIds = [...parsed.completedPageIds];
      initialDone = parsed.done;
      initialAdded = parsed.addedMessages;
      initialOk = parsed.okPages;
      initialErrors = [...parsed.errorPages];
      this.backfillJobId = pausedJob.id;
      resumeFromJob = true;
      await this.prisma.cskhJobRun.update({
        where: { id: pausedJob.id },
        data: { status: 'running', finishedAt: null },
      });
    } else {
      if (options?.force) {
        await this.prisma.cskhJobRun.updateMany({
          where: { type: 'inbox-backfill', status: 'paused', ...(tenantId ? { tenantId } : {}) },
          data: { status: 'cancelled', finishedAt: new Date() },
        });
      }
      const job = await this.prisma.cskhJobRun.create({
        data: {
          type: 'inbox-backfill',
          status: 'running',
          tenantId,
          summary: {
            scope,
            total: totalAllPages,
            done: 0,
            completedPageIds: [],
            addedMessages: 0,
            okPages: 0,
            errorPages: [],
          } as unknown as Prisma.InputJsonValue,
        },
      });
      this.backfillJobId = job.id;
    }

    const jobId = this.backfillJobId!;
    const queued = await this.redisQueue.enqueueBackfillJob({ jobId });
    if (!queued) {
      if (getCskhRunMode() === 'all') {
        void this.executeBackfillJob(jobId).catch((e) => {
          this.logger.error(`[backfill] inline job lỗi: ${(e as Error).message}`);
        });
      } else {
        await this.prisma.cskhJobRun.update({
          where: { id: jobId },
          data: {
            status: 'failed',
            error: 'Không xếp hàng được — kiểm tra REDIS_URL và worker (CSKH_RUN_MODE=worker)',
            finishedAt: new Date(),
          },
        });
        this.backfillJobId = null;
        throw new BadRequestException(
          'Không thể xếp hàng quét đầy đủ (Redis). Kiểm tra REDIS_URL và worker service.',
        );
      }
    }

    const jobRow = await this.prisma.cskhJobRun.findUnique({ where: { id: jobId } });
    if (jobRow) {
      return this.backfillStatusFromJob(jobRow, { running: true, paused: false });
    }

    return {
      running: true,
      paused: false,
      scope,
      total: totalAllPages,
      done: initialDone,
      currentPage: null,
      addedMessages: initialAdded,
      okPages: initialOk,
      errorPages: initialErrors,
      startedAt: resumeFromJob
        ? (pausedJob!.startedAt.toISOString())
        : new Date().toISOString(),
      finishedAt: null,
      jobId,
    };
  }

  /** Worker gọi — thực thi job quét đầy đủ đã xếp hàng. */
  async executeBackfillJob(jobId: string): Promise<void> {
    const mode = getCskhRunMode();
    if (!isCskhWorkerProcess() && mode !== 'all') {
      this.logger.error(
        `[backfill] executeBackfillJob bị từ chối trên process CSKH_RUN_MODE=${mode} — chỉ chạy trên worker`,
      );
      return;
    }
    this.logger.log(`[backfill] WORKER bắt đầu job ${jobId.slice(0, 8)} (CSKH_RUN_MODE=${mode})`);

    const job = await this.prisma.cskhJobRun.findUnique({ where: { id: jobId } });
    if (!job || job.type !== 'inbox-backfill') {
      this.logger.log(`[backfill] worker skip ${jobId.slice(0, 8)} — job không tồn tại`);
      return;
    }
    if (job.status !== 'running') {
      this.logger.log(`[backfill] worker skip ${jobId.slice(0, 8)} — status=${job.status}`);
      return;
    }
    if (this.backfillState.running && this.backfillJobId !== jobId) {
      this.logger.warn(`[backfill] worker bỏ qua ${jobId.slice(0, 8)} — đang chạy job khác`);
      return;
    }
    if (this.backfillState.running && this.backfillJobId === jobId) {
      this.logger.log(`[backfill] worker skip ${jobId.slice(0, 8)} — đã chạy trên process này`);
      return;
    }

    const parsed = this.jobSummaryToState(job.summary as Record<string, unknown>);
    const scope = (parsed.scope || 'all') as 'empty' | 'all';
    const tenantId = job.tenantId ?? undefined;

    this.backfillJobId = jobId;
    this.backfillTenantId = tenantId;
    this.backfillCompletedPageIds = [...parsed.completedPageIds];
    this.backfillPauseRequested = false;
    await this.redisQueue.clearBackfillPauseRequested(jobId);
    await this.redisQueue.clearBackfillCancelRequested(jobId);

    this.backfillState = {
      running: true,
      paused: false,
      scope,
      total: parsed.total,
      done: parsed.done,
      currentPage: null,
      pageConvsDone: 0,
      addedMessages: parsed.addedMessages,
      okPages: parsed.okPages,
      errorPages: [...parsed.errorPages],
      startedAt: job.startedAt.toISOString(),
      finishedAt: null,
      jobId,
    };

    const pages = await this.buildBackfillPageList(scope, tenantId, parsed.completedPageIds);

    this.startBackfillPausePoller();
    try {
      await this.runBackfillJob(pages);
    } catch (e) {
      if (await this.isBackfillCancelledNow()) {
        this.logger.log(`[backfill] job ${jobId.slice(0, 8)} đã hủy — bỏ qua lỗi`);
        return;
      }
      this.logger.error(`[backfill] job lỗi tổng: ${(e as Error).message}`);
      this.backfillState.running = false;
      this.backfillState.finishedAt = new Date().toISOString();
      await this.persistBackfillJob('failed', this.backfillCompletedPageIds);
      await this.prisma.cskhJobRun.update({
        where: { id: jobId },
        data: { error: (e as Error).message },
      });
    } finally {
      this.stopBackfillPausePoller();
    }
  }

  private async runBackfillJob(pages: Array<{ pageId: string; pageName: string | null }>) {
    this.logger.log(
      `[backfill] bắt đầu quét ${pages.length} kênh còn lại — tuần tự từng kênh, xong hết mới sang kênh tiếp (scope=${this.backfillState.scope}, đã xong ${this.backfillCompletedPageIds.length})`,
    );
    for (const row of pages) {
      if (await this.isBackfillCancelledNow()) {
        await this.finishBackfillCancel();
        this.logger.log(`[backfill] ĐÃ HỦY tại ${this.backfillState.done}/${this.backfillState.total} kênh`);
        return;
      }
      if (await this.isBackfillPauseRequestedNow()) {
        await this.finishBackfillPause();
        this.logger.log(`[backfill] TẠM DỪNG tại ${this.backfillState.done}/${this.backfillState.total} kênh`);
        return;
      }

      this.backfillState.currentPage = row.pageName || row.pageId;
      this.backfillState.pageConvsDone = 0;
      await this.persistBackfillJob('running', this.backfillCompletedPageIds, { force: true });
      this.logger.log(
        `[backfill] (${this.backfillState.done + 1}/${this.backfillState.total}) bắt đầu kênh: ${row.pageName || row.pageId}`,
      );

      let pageCompleted = false;
      try {
        const page = await this.prisma.facebookCskhConfig.findUnique({
          where: { pageId: row.pageId },
        });
        if (page) {
          const added = await Promise.race([
            this.syncSinglePageFromGraph(page, true, true, {
              backfillMode: true,
              shouldStop: () => this.backfillCancelRequested,
            }),
            new Promise<number>((_, reject) => {
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `Timeout quét kênh sau ${Math.round(this.backfillPageTimeoutMs / 60_000)} phút`,
                    ),
                  ),
                this.backfillPageTimeoutMs,
              );
            }),
          ]);
          if (await this.isBackfillCancelledNow()) {
            await this.finishBackfillCancel();
            this.logger.log(`[backfill] ĐÃ HỦY giữa kênh ${row.pageName || row.pageId}`);
            return;
          }
          if (this.backfillPauseRequested) {
            await this.finishBackfillPause();
            this.logger.log(`[backfill] TẠM DỪNG giữa kênh ${row.pageName || row.pageId} tại ${this.backfillState.done}/${this.backfillState.total}`);
            return;
          }
          this.backfillState.addedMessages += added;
          this.backfillState.okPages++;
          this.backfillCompletedPageIds.push(row.pageId);
          pageCompleted = true;
          this.logger.log(
            `[backfill] (${this.backfillState.done + 1}/${this.backfillState.total}) ${row.pageName || row.pageId}: +${added} tin`,
          );
        } else {
          pageCompleted = true;
          this.backfillCompletedPageIds.push(row.pageId);
        }
      } catch (e) {
        this.backfillState.errorPages.push({
          page: row.pageName || row.pageId,
          pageId: row.pageId,
          error: (e as Error).message,
        });
        this.backfillCompletedPageIds.push(row.pageId);
        pageCompleted = true;
        this.logger.warn(`[backfill] LỖI page ${row.pageName || row.pageId}: ${(e as Error).message}`);
      } finally {
        if (pageCompleted) {
          this.backfillState.done++;
          try {
            await this.cskh.bumpPageStatsCaches(this.backfillTenantId, { inboundOnly: true });
            void this.cskh
              .syncPageAdSpendAfterBackfillPage(row.pageId, this.backfillTenantId)
              .catch((e) => {
                this.logger.warn(
                  `[backfill] QC sync ${row.pageName || row.pageId}: ${(e as Error).message}`,
                );
              });
            void this.cskh.refreshPageMessageTotals([row.pageId]).catch((e) => {
              this.logger.warn(
                `[backfill] refresh msg totals ${row.pageName || row.pageId}: ${(e as Error).message}`,
              );
            });
          } catch (e) {
            this.logger.warn(
              `[backfill] bump stats cache ${row.pageName || row.pageId}: ${(e as Error).message}`,
            );
          }
        }
        await this.persistBackfillJob(
          this.backfillPauseRequested ? 'paused' : 'running',
          this.backfillCompletedPageIds,
          { force: true },
        );
      }

      if (await this.isBackfillCancelledNow()) {
        await this.finishBackfillCancel();
        return;
      }
      if (await this.isBackfillPauseRequestedNow()) {
        await this.finishBackfillPause();
        return;
      }
    }

    this.backfillState.running = false;
    this.backfillState.paused = false;
    this.backfillState.currentPage = null;
    this.backfillState.finishedAt = new Date().toISOString();
    await this.persistBackfillJob('completed', this.backfillCompletedPageIds);
    this.logger.log(
      `[backfill] XONG: ${this.backfillState.okPages}/${this.backfillState.total} page OK, ` +
        `+${this.backfillState.addedMessages} tin, ${this.backfillState.errorPages.length} page lỗi`,
    );
    void this.syncPageAdSpendAfterBackfill();
  }

  /** Sau quét đầy đủ — đồng bộ chi tiêu QC hôm qua + hôm nay (VN), chỉ khi không còn quét. */
  private async syncPageAdSpendAfterBackfill(): Promise<void> {
    try {
      const today = this.cskh.vietnamCalendarDate(0);
      const yesterday = this.cskh.vietnamCalendarDate(-1);
      this.logger.log(`[backfill] Đồng bộ chi tiêu QC Page/Kênh — ${yesterday}, ${today}`);
      const result = await this.cskh.syncAllPagesAdSpend(
        [yesterday, today],
        this.backfillTenantId,
      );
      this.logger.log(
        `[backfill] Chi tiêu QC xong: ${result.synced} bản ghi / ${result.pages} kênh × ${result.dates.length} ngày`,
      );
    } catch (e) {
      this.logger.warn(`[backfill] Đồng bộ chi tiêu QC lỗi: ${(e as Error).message}`);
    }
  }

  /** Quét 1 page từ Graph. Tách riêng để cô lập lỗi từng page trong syncFromGraph. */
  private async syncSinglePageFromGraph(
    page: FacebookCskhConfig,
    full: boolean,
    lightweight = false,
    options?: { backfillMode?: boolean; shouldStop?: () => boolean },
  ): Promise<number> {
    let synced = 0;
    const backfillMode = options?.backfillMode === true;
    const monitorMode = !full && lightweight && !backfillMode;

    const processConv = async (fbConv: FbConversation): Promise<number> => {
      const run = async (): Promise<number> => {
      if (options?.shouldStop?.()) return 0;
      if (backfillMode && (await this.isBackfillCancelledNow())) return 0;
      if (backfillMode && (await this.isBackfillPauseRequestedNow())) return 0;
      if (!backfillMode) {
        if (await this.redisQueue.isInboxHot()) return 0;
        if ((await this.redisQueue.getWebhookQueueDepth()) > 2) return 0;
      }
      try {
        const participants = fbConv.participants?.data ?? [];
        const customer = participants.find((p) => String(p.id) !== String(page.pageId));
        if (!customer?.id) return 0;

        const rawMsgs = backfillMode
          ? await this.graph.fetchAllMessagesFromInline(
              fbConv.messages?.data,
              fbConv.messages?.paging?.next,
              page.pageAccessToken,
              {
                shouldStop: () =>
                  Boolean(options?.shouldStop?.() || this.backfillPauseRequested),
                maxPages: this.backfillMsgMaxPages,
              },
            )
          : monitorMode
            ? (fbConv.messages?.data ?? [])
            : await this.graph.fetchMessages(
                fbConv.id,
                page.pageAccessToken,
                full ? 0 : this.msgLimit,
              );
        const customerName = this.graph.resolveCustomerName(
          fbConv.participants,
          page.pageId,
          rawMsgs,
        );
        let customerPictureUrl: string | null = null;
        if (!lightweight && page.pageAccessToken) {
          const profile = await this.graph.getMessengerUserProfile(
            String(customer.id),
            page.pageAccessToken,
          );
          customerPictureUrl = profile.pictureUrl;
        }

        const oldConv = backfillMode
          ? null
          : await this.prisma.cskhInboxConversation.findUnique({
              where: {
                pageId_participantPsid: {
                  pageId: page.pageId,
                  participantPsid: String(customer.id),
                },
              },
              select: { id: true, unreadCount: true, lastMessageAt: true },
            });

        const customerPsid = String(customer.id);
        const trailingUnread = computeTrailingCustomerUnread(
          rawMsgs,
          page.pageId,
          customerPsid,
        );
        const newestNorm = rawMsgs.length
          ? this.graph.normalizeMessageForInbox(rawMsgs[0], page.pageId, customerPsid)
          : null;
        const unreadCount = newestNorm?.sender === 'Staff' ? 0 : trailingUnread;
        const lastMessagePreview =
          newestNorm?.text ?? rawMsgs[0]?.message?.trim() ?? null;

        const conv = await this.prisma.cskhInboxConversation.upsert({
          where: {
            pageId_participantPsid: {
              pageId: page.pageId,
              participantPsid: String(customer.id),
            },
          },
          create: {
            pageId: page.pageId,
            pageName: page.pageName,
            fbConversationId: fbConv.id,
            participantPsid: String(customer.id),
            customerName,
            customerPictureUrl,
            unreadCount,
            lastMessage: lastMessagePreview,
            lastMessageAt: fbConv.updated_time ? new Date(fbConv.updated_time) : new Date(),
            tenantId: page.tenantId,
          },
          update: {
            pageName: page.pageName ?? undefined,
            fbConversationId: fbConv.id,
            customerName,
            customerPictureUrl: customerPictureUrl ?? undefined,
            unreadCount,
            lastMessage: lastMessagePreview ?? undefined,
            lastMessageAt: fbConv.updated_time ? new Date(fbConv.updated_time) : undefined,
            tenantId: page.tenantId ?? undefined,
          },
        });

        if (!backfillMode && fbConv.unread_count === 0) {
          const messageWhere: any = {
            conversationId: conv.id,
            direction: 'inbound',
            status: { notIn: ['read', 'failed'] },
          };
          if (page.tenantId) messageWhere.tenantId = page.tenantId;
          await this.prisma.cskhInboxMessage.updateMany({
            where: messageWhere,
            data: { status: 'read' },
          });
        }

        let isNewConv = false;
        let lastMsgChanged = false;
        if (!backfillMode) {
          const unreadCountChanged = oldConv && oldConv.unreadCount !== conv.unreadCount;
          isNewConv = !oldConv;
          lastMsgChanged = Boolean(
            oldConv &&
              oldConv.lastMessageAt?.getTime() !== conv.lastMessageAt?.getTime(),
          );
          if (unreadCountChanged || isNewConv || lastMsgChanged) {
            this.realtime.publish({
              type: 'conversation',
              conversationId: conv.id,
              pageId: conv.pageId,
              conversation: this.formatConversationRow(conv),
              tenantId: conv.tenantId || undefined,
            });
          }
        }

        if (lightweight) {
          const added = await this.fastPersistMessages(
            conv.id,
            page.pageId,
            rawMsgs,
            page.tenantId,
            customerPsid,
          );
          if (
            !backfillMode &&
            added > 0 &&
            (lastMsgChanged || isNewConv) &&
            newestNorm
          ) {
            const latest = await this.prisma.cskhInboxMessage.findFirst({
              where: { conversationId: conv.id },
              orderBy: { sentAt: 'desc' },
            });
            if (latest) {
              this.publishMessageRealtime(
                page.pageId,
                conv.id,
                [latest],
                latest.senderType === 'customer',
                page.tenantId || undefined,
                conv,
              );
            }
          }
          return added;
        }

        await this.reconcileMessageSenders(conv.id, page.pageId, customerPsid, rawMsgs);

        const ordered = [...rawMsgs].reverse();
        let lastPreview: string | null = null;
        let count = 0;
        for (const msg of ordered) {
          const saved = await this.persistGraphMessage(
            conv.id,
            page.pageId,
            msg,
            page.pageAccessToken,
            page.tenantId || undefined,
            customerPsid,
          );
          if (saved) {
            lastPreview = saved.text;
            count++;
          }
        }
        if (lastPreview) {
          await this.prisma.cskhInboxConversation.update({
            where: { id: conv.id },
            data: { lastMessage: lastPreview },
          });
        }
        await this.markAdFromGraphMessages(conv.id, rawMsgs);
        return count;
      } catch (e) {
        this.logger.warn(
          `[syncFromGraph${full ? ':full' : ''}] bỏ qua hội thoại ${fbConv.id} (page ${page.pageName || page.pageId}): ${(e as Error).message}`,
        );
        return 0;
      }
      };

      try {
        const result = backfillMode
          ? await Promise.race([
              run(),
              new Promise<number>((_, reject) => {
                setTimeout(
                  () => reject(new Error('Timeout hội thoại')),
                  this.backfillConvTimeoutMs,
                );
              }),
            ])
          : await run();
        if (backfillMode) {
          this.backfillState.pageConvsDone++;
          await this.persistBackfillJob('running', this.backfillCompletedPageIds);
        }
        return result;
      } catch (e) {
        if (backfillMode) {
          this.backfillState.pageConvsDone++;
          await this.persistBackfillJob('running', this.backfillCompletedPageIds);
        }
        this.logger.warn(
          `[syncFromGraph${full ? ':full' : ''}] bỏ qua hội thoại ${fbConv.id} (page ${page.pageName || page.pageId}): ${(e as Error).message}`,
        );
        return 0;
      }
    };

    const runConvBatch = async (batch: FbConversation[]): Promise<'stop' | 'continue'> => {
      if (options?.shouldStop?.()) return 'stop';
      if (backfillMode && (await this.isBackfillCancelledNow())) return 'stop';
      if (backfillMode && (await this.isBackfillPauseRequestedNow())) return 'stop';
      if (!backfillMode && (await this.redisQueue.isInboxHot())) return 'stop';
      for (const fbConv of batch) {
        if (options?.shouldStop?.()) return 'stop';
        if (backfillMode && (await this.isBackfillCancelledNow())) return 'stop';
        if (backfillMode && (await this.isBackfillPauseRequestedNow())) return 'stop';
        synced += await processConv(fbConv);
      }
      return 'continue';
    };

    if (backfillMode && full) {
      const total = await this.graph.streamConversationsForBackfill(
        page.pageId,
        page.pageAccessToken,
        this.msgLimit,
        {
          shouldStop: () => Boolean(options?.shouldStop?.() || this.backfillPauseRequested),
          onBatch: async (batch) => {
            const r = await runConvBatch(batch);
            return r === 'stop' ? 'stop' : 'continue';
          },
        },
      );
      this.logger.log(
        `[backfill] ${page.pageName || page.pageId}: đã quét ${total} hội thoại, +${synced} tin`,
      );
      return synced;
    }

    const convs = full
      ? await this.graph.fetchAllConversationsForAudit(
          page.pageId,
          page.pageAccessToken,
          0,
          this.msgLimit,
          undefined,
          options?.shouldStop,
        )
      : await this.graph.fetchConversationsForMonitor(
          page.pageId,
          page.pageAccessToken,
          this.syncLimit,
        );
    this.logger.log(
      `[syncFromGraph${full ? ':full' : ''}] ${page.pageName || page.pageId}: ${convs.length} hội thoại`,
    );

    for (const fbConv of convs) {
      if (options?.shouldStop?.()) break;
      if (backfillMode && (await this.isBackfillPauseRequestedNow())) break;
      if (!backfillMode && (await this.redisQueue.isInboxHot())) {
        this.logger.log(
          `[syncFromGraph] Dừng quét page ${page.pageName || page.pageId} — nhường inbox realtime`,
        );
        break;
      }
      synced += await processConv(fbConv);
    }
    return synced;
  }

  /**
   * Tự động liên kết Inbox, đồng bộ tin nhắn cũ và phân tích Intent khi Audit Job chấm điểm xong.
   * Chạy nền không chặn tiến trình chấm điểm AI.
   */
  async autoLinkAndSync(
    auditId: string,
    conv: FbConversation,
    messages: FbMessage[],
    pageId: string,
    pageAccessToken: string,
    customerName: string,
    tenantId?: string,
  ) {
    const participantPsid = this.graph.resolveParticipantPsid(conv.participants, pageId);
    if (!participantPsid) {
      this.logger.warn(`[AutoLinkAndSync] Cannot resolve participantPsid for convId=${conv.id}`);
      return;
    }

    const customerPictureUrl: string | null = null;
    const finalCustomerName = customerName;

    const page = await this.prisma.facebookCskhConfig.findFirst({
      where: tenantId ? { pageId, tenantId } : { pageId },
    });
    const pageName = page?.pageName ?? null;

    const inboxConv = await this.prisma.cskhInboxConversation.upsert({
      where: { pageId_participantPsid: { pageId, participantPsid } },
      create: {
        pageId,
        pageName,
        fbConversationId: conv.id,
        participantPsid,
        customerName: finalCustomerName,
        customerPictureUrl,
        lastMessage: messages[messages.length - 1]?.message ?? null,
        lastMessageAt: conv.updated_time ? new Date(conv.updated_time) : new Date(),
        tenantId,
      },
      update: {
        fbConversationId: conv.id,
        customerName: finalCustomerName || undefined,
        customerPictureUrl: customerPictureUrl || undefined,
      },
    });

    // Đồng bộ tin nhắn
    if (messages.length) {
      const ordered = [...messages].reverse();
      let lastPreview: string | null = null;
      for (const msg of ordered) {
        const saved = await this.persistGraphMessage(
          inboxConv.id,
          pageId,
          msg,
          pageAccessToken,
          tenantId,
          participantPsid,
        );
        if (saved) lastPreview = saved.text;
      }
      if (lastPreview) {
        await this.prisma.cskhInboxConversation.update({
          where: { id: inboxConv.id },
          data: { lastMessage: lastPreview },
        });
      }
      await this.markAdFromGraphMessages(inboxConv.id, messages);
    }

    // Phân tích ý định khách hàng bằng AI & Sapo Matching
    const intentMessages = messages
      .map((m) => {
        const isStaff = m.from?.id === pageId;
        return {
          sender: isStaff ? 'Staff' : 'Customer',
          text: (m.message ?? '').trim(),
        };
      })
      .filter((m) => m.text.length > 0);

    if (intentMessages.length > 0) {
      try {
        const aiMessages = capIntentMessages(intentMessages);
        const signature = `${auditId}|${intentMessagesSignature(aiMessages)}`;

        const analyzed = await this.ai.analyzeCustomerIntent({
          messages: aiMessages,
          customerName: finalCustomerName,
        });

        const sapoConfigured = this.sapoProducts.isConfigured();
        let products: CustomerIntentPayload['products'];
        if (sapoConfigured) {
          const catalog = await this.sapoProducts.getCatalog();
          products = matchInterestedProducts(
            catalog,
            analyzed.productMentions ?? [],
            analyzed.topics,
            analyzed.summary,
          );
        }

        const payload: CustomerIntentPayload = {
          summary: analyzed.summary,
          intentLabel: analyzed.intentLabel,
          topics: analyzed.topics,
          urgency: analyzed.urgency,
          suggestedFocus: analyzed.suggestedFocus,
          suggestedReply: analyzed.suggestedReply,
          analyzedAt: new Date().toISOString(),
          productMentions: analyzed.productMentions,
          products,
          sapoConfigured,
        };

        // Cache in memory cho endpoint GET intent
        const cacheKey = `${inboxConv.id}:${auditId}`;
        this.intentCache.set(cacheKey, { signature, at: Date.now(), data: payload });

        // Cập nhật metadata của bản ghi ChatAudit
        const audit = await this.prisma.chatAudit.findUnique({
          where: { id: auditId },
          select: { metadata: true },
        });
        if (audit) {
          const currentMeta = (audit.metadata as Record<string, any> | null) ?? {};
          currentMeta.customerIntent = payload;
          await this.prisma.chatAudit.update({
            where: { id: auditId },
            data: { metadata: currentMeta },
          });
        }
      } catch (err) {
        this.logger.warn(`[AutoLinkAndSync] Failed to analyze customer intent: ${(err as Error).message}`);
      }
    }
  }

  /** Liên kết inbox từ metadata audit — dùng PSID hoặc FB conversation id lưu trong audit. */
  async linkFromAudit(auditId: string, tenantId?: string) {
    type AuditMeta = {
      pageId?: string;
      conversationId?: string;
      participantPsid?: string;
      pageName?: string;
    };

    const audit = await this.prisma.chatAudit.findFirst({
      where: tenantId ? { id: auditId, tenantId } : { id: auditId },
    });
    if (!audit) throw new NotFoundException('Audit không tồn tại hoặc không có quyền');

    const meta = (audit.metadata as AuditMeta | null) ?? {};
    const pageId = meta.pageId?.trim();
    if (!pageId) throw new BadRequestException('Audit thiếu pageId');

    const page = await this.prisma.facebookCskhConfig.findFirst({
      where: tenantId ? { pageId, tenantId } : { pageId },
    });
    if (!page?.pageAccessToken) {
      throw new BadRequestException('Page chưa được kết nối OAuth');
    }

    let participantPsid = meta.participantPsid?.trim() || null;
    let fbConversationId = meta.conversationId?.trim() || null;
    let updatedTime: string | undefined;
    let participants = null as { data?: Array<{ id?: string; name?: string }> } | null | undefined;

    if (fbConversationId) {
      const fbConv = await this.graph.fetchConversationById(fbConversationId, page.pageAccessToken);
      if (fbConv) {
        participants = fbConv.participants;
        participantPsid =
          participantPsid || this.graph.resolveParticipantPsid(fbConv.participants, pageId);
        updatedTime = fbConv.updated_time;
      }
    }

    if (!participantPsid) {
      throw new BadRequestException(
        'Không xác định được PSID khách — chạy audit mới để gắn participantPsid.',
      );
    }

    const existing = await findInboxConversationByPageParticipant(
      this.prisma,
      pageId,
      participantPsid,
      tenantId,
    );
    if (existing) return existing;

    const rawMsgs = fbConversationId
      ? await this.graph.fetchMessages(fbConversationId, page.pageAccessToken, this.msgLimit)
      : [];

    let customerName = audit.customerName;
    if (participants) {
      customerName = this.graph.resolveCustomerName(participants, pageId, rawMsgs);
    }

    let customerPictureUrl: string | null = null;
    const profile = await this.graph.getMessengerUserProfile(participantPsid, page.pageAccessToken);
    customerName = profile.name ?? customerName;
    customerPictureUrl = profile.pictureUrl;

    const conv = await this.prisma.cskhInboxConversation.upsert({
      where: { pageId_participantPsid: { pageId, participantPsid } },
      create: {
        pageId,
        pageName: page.pageName ?? meta.pageName ?? null,
        fbConversationId,
        participantPsid,
        customerName,
        customerPictureUrl,
        lastMessage: rawMsgs[0]?.message ?? null,
        lastMessageAt: updatedTime ? new Date(updatedTime) : new Date(),
        tenantId: page.tenantId,
      },
      update: {
        pageName: page.pageName ?? undefined,
        fbConversationId: fbConversationId ?? undefined,
        customerName: customerName ?? undefined,
        customerPictureUrl: customerPictureUrl ?? undefined,
        lastMessage: rawMsgs[0]?.message ?? undefined,
        lastMessageAt: updatedTime ? new Date(updatedTime) : undefined,
        tenantId: page.tenantId ?? undefined,
      },
    });

    if (fbConversationId && rawMsgs.length) {
      const ordered = [...rawMsgs].reverse();
      let lastPreview: string | null = null;
      for (const msg of ordered) {
        const saved = await this.persistGraphMessage(
          conv.id,
          pageId,
          msg,
          page.pageAccessToken,
          page.tenantId || undefined,
          participantPsid,
        );
        if (saved) lastPreview = saved.text;
      }
      if (lastPreview) {
        await this.prisma.cskhInboxConversation.update({
          where: { id: conv.id },
          data: { lastMessage: lastPreview },
        });
      }
    }

    return conv;
  }

  async getLatestAuditForConversation(conversationId: string, tenantId?: string) {
    const conv = await findInboxConversationById(this.prisma, conversationId, tenantId);
    if (!conv) throw new NotFoundException('Hội thoại không tồn tại hoặc không có quyền');

    type Row = {
      id: string;
      score: number;
      feedback: string | null;
      metadata: unknown;
      transcript: unknown;
      customerName: string | null;
      agentName: string | null;
      createdAt: Date;
    };
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT id, score, feedback, metadata, transcript, customer_name AS "customerName",
             agent_name AS "agentName", created_at AS "createdAt"
      FROM chat_audits
      WHERE metadata->>'pageId' = ${conv.pageId}
        AND (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
      ORDER BY created_at DESC
      LIMIT 100
    `;
    if (conv.fbConversationId) {
      const byFb = rows.find(
        (r) => (r.metadata as { conversationId?: string } | null)?.conversationId === conv.fbConversationId,
      );
      if (byFb) return byFb;
    }
    if (conv.customerName) {
      return rows.find((r) => r.customerName === conv.customerName) ?? null;
    }
    return null;
  }
}
