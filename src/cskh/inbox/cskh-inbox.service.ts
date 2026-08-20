import { BadRequestException, Injectable, Logger, NotFoundException, Inject, forwardRef, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
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
  inboxListPreview,
} from '../facebook/facebook-message.util';
import {
  detectAdFromFbMessages,
  AD_REFERRAL_ILIKE_SUBSTRINGS,
  type FbWebhookReferral,
  parseWebhookReferral,
} from '../facebook/facebook-referral.util';
import { getFacebookWebhookVerifyToken, cskhInboxGraphPlatform } from '../facebook/facebook-oauth.util';
import {
  CskhInboxRealtimeService,
  type CustomerIntentPayload,
  type InboxConversationPayload,
  type InboxMessagePayload,
} from './cskh-inbox-realtime.service';
import {
  inboxRtTraceDone,
  inboxRtTraceMark,
  inboxRtTraceStart,
} from './inbox-realtime-debug.util';
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
  isPrismaRetryableDbError,
  type InboxConversationAccess,
} from './cskh-inbox-conversation.util';
import { getCskhRunMode, isCskhWorkerProcess } from '../cskh-run-mode';
import { isPrismaRecentlyBusy } from '../../common/prisma-busy.util';

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

const INBOX_MESSAGE_SELECT_LEGACY = {
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

const INBOX_MESSAGE_SELECT = {
  ...INBOX_MESSAGE_SELECT_LEGACY,
  originalText: true,
  translatedText: true,
  sourceLang: true,
} as const;

type InboxMessageRow = {
  id: string;
  conversationId: string;
  fbMessageId: string | null;
  direction: string;
  senderType: string;
  text: string;
  originalText?: string | null;
  translatedText?: string | null;
  sourceLang?: string | null;
  messageType: string;
  attachmentUrl: string | null;
  sentAt: Date;
  status: string;
};

@Injectable()
export class CskhInboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CskhInboxService.name);
  private readonly syncLimit = Number(process.env.CSKH_INBOX_SYNC_LIMIT || 150);
  private readonly listSyncCooldownMs = Number(process.env.CSKH_INBOX_LIST_SYNC_COOLDOWN_MS || 3_000);
  private readonly lastListSync = new Map<string, number>();
  /** Quét luân phiên khi xem "Tất cả Page" — mỗi lần sync N page, không quét 87 page cùng lúc. */
  private readonly allPagesSyncBatch = Number(process.env.CSKH_INBOX_ALL_PAGES_SYNC_BATCH || 2);
  private readonly allPagesSyncCooldownMs = Number(
    process.env.CSKH_INBOX_ALL_PAGES_SYNC_COOLDOWN_MS || 45_000,
  );
  /** Redis tắt — quét nhiều page hơn / cooldown ngắn hơn để bù webhook. */
  private readonly redisOffSyncBatch = Number(process.env.CSKH_INBOX_REDIS_OFF_SYNC_BATCH || 4);
  private readonly redisOffSyncCooldownMs = Number(
    process.env.CSKH_INBOX_REDIS_OFF_SYNC_COOLDOWN_MS || 20_000,
  );
  private readonly redisOffListSyncCooldownMs = Number(
    process.env.CSKH_INBOX_REDIS_OFF_LIST_SYNC_COOLDOWN_MS || 25_000,
  );
  private allPagesSyncCursor = 0;
  private lastAllPagesRotatingSync = 0;
  private backgroundInboxSyncRunning = false;
  private avatarEnrichRunning = false;
  /** Tắt mặc định — tránh quét inbox nền khi mở danh sách (chỉ bật khi CSKH_INBOX_ROTATING_SYNC_ENABLED=true). */
  private readonly rotatingSyncEnabled =
    process.env.CSKH_INBOX_ROTATING_SYNC_ENABLED === 'true';
  /** Worker poll Graph để bù tin mới khi webhook Meta chưa về. Tắt: CSKH_INBOX_CATCHUP_ENABLED=false */
  private readonly catchUpEnabled = process.env.CSKH_INBOX_CATCHUP_ENABLED !== 'false';
  private readonly catchUpIntervalMs = Math.max(
    2_000,
    Number(process.env.CSKH_INBOX_CATCHUP_INTERVAL_MS || 3_000),
  );
  private readonly catchUpHotPages = Math.min(
    4,
    Math.max(1, Number(process.env.CSKH_INBOX_CATCHUP_HOT_PAGES || 1)),
  );
  private readonly catchUpConvLimit = Math.min(
    40,
    Math.max(8, Number(process.env.CSKH_INBOX_CATCHUP_CONV_LIMIT || 12)),
  );
  private catchUpTimer: ReturnType<typeof setInterval> | null = null;
  private liveCatchUpRunning = false;
  private liveViewedPageId: string | null = null;
  private catchUpBackoffUntil = 0;
  private auditRunningCache: { at: number; value: boolean } = { at: 0, value: false };
  private readonly msgLimit = Number(process.env.CSKH_INBOX_MSG_LIMIT || 250);
  /** Khi recheck audit — tải nhiều tin hơn để so khớp transcript. */
  private readonly auditRecheckMsgLimit = Number(
    process.env.CSKH_INBOX_AUDIT_RECHECK_LIMIT || 400,
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
    { at: number; data: { total: number; fromAd: number; unread: number; normal: number } }
  >();
  private readonly conversationStatsRefreshing = new Set<string>();
  private readonly conversationStatsTtlMs = Number(
    process.env.CSKH_CONVERSATION_STATS_TTL_MS || 120_000,
  );
  /** Giới hạn webhook xử lý inline trên API khi worker chết — tránh treo web. */
  private inlineWebhookInflight = 0;
  private readonly maxInlineWebhook = Number(process.env.CSKH_WEBHOOK_INLINE_MAX || 3);
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
  /** Chặn double-click / retry gửi cùng nội dung trong vài giây. */
  private readonly inflightSends = new Map<string, Promise<InboxMessagePayload>>();
  /** Giới hạn kéo lịch sử Graph khi mở / cuộn lên (toàn bộ tin cũ). */
  private readonly historyMsgLimit = Number(process.env.CSKH_INBOX_HISTORY_LIMIT || 1200);
  private readonly lastDeepHistory = new Map<string, number>();
  private readonly inflightDeepHistory = new Map<string, Promise<void>>();
  private readonly deepHistoryCooldownMs = Number(
    process.env.CSKH_INBOX_DEEP_HISTORY_COOLDOWN_MS || 600_000,
  );

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
    /** Quét tin theo ngày VN (YYYY-MM-DD). Null = quét toàn bộ lịch sử. */
    scanDate: string | null;
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
    scanDate: null,
  };

  private toBackfillResponse() {
    return { ...this.backfillState };
  }

  private jobSummaryToState(summary: Record<string, unknown> | null | undefined) {
    const s = summary ?? {};
    const scanDateRaw = typeof s.scanDate === 'string' ? s.scanDate.trim() : '';
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
      scanDate: /^\d{4}-\d{2}-\d{2}$/.test(scanDateRaw) ? scanDateRaw : null,
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
      scanDate: parsed.scanDate,
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
      scanDate: this.backfillState.scanDate,
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

  onModuleInit(): void {
    if (!this.catchUpEnabled) return;
    if (!isCskhWorkerProcess()) return;
    this.logger.log(
      `[catch-up] Worker poll Graph realtime mỗi ${this.catchUpIntervalMs}ms (head ${this.catchUpConvLimit} hội thoại)`,
    );
    this.catchUpTimer = setInterval(() => {
      void this.runLiveGraphCatchUp().catch((e) => {
        const msg = (e as Error).message || '';
        if (/connection pool|Timed out fetching/i.test(msg)) {
          this.catchUpBackoffUntil = Date.now() + 20_000;
        }
        this.logger.warn(`[catch-up] ${msg}`);
      });
    }, this.catchUpIntervalMs);
    void this.runLiveGraphCatchUp().catch((e) => {
      this.logger.warn(`[catch-up] lần đầu: ${(e as Error).message}`);
    });
  }

  onModuleDestroy(): void {
    if (this.catchUpTimer) {
      clearInterval(this.catchUpTimer);
      this.catchUpTimer = null;
    }
  }

  /**
   * Ghi page NV đang xem để poll Graph ưu tiên page đó.
   * Không đánh dấu inbox hot — hot chỉ từ webhook thật.
   */
  touchUserActivity(pageId?: string): void {
    const id = pageId?.trim();
    if (!id) return;
    this.liveViewedPageId = id;
    void this.redisQueue.markViewedInboxPage(id);
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

  private formatMessageRow(row: CskhInboxMessage | InboxMessageRow): InboxMessagePayload {
    return {
      id: row.id,
      conversationId: row.conversationId,
      fbMessageId: row.fbMessageId,
      direction: row.direction,
      senderType: row.senderType,
      text: row.text,
      originalText: row.originalText ?? null,
      translatedText: row.translatedText ?? null,
      sourceLang: row.sourceLang ?? null,
      messageType: row.messageType,
      attachmentUrl: row.attachmentUrl,
      sentAt: row.sentAt.toISOString(),
      status: row.status,
    };
  }

  private formatConversationRow(conv: CskhInboxConversation | InboxConversationAccess): InboxConversationPayload {
    return {
      id: conv.id,
      pageId: conv.pageId,
      pageName: conv.pageName,
      fbConversationId: conv.fbConversationId,
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
      customerLang: conv.customerLang ?? null,
      customerLangLabel: conv.customerLangLabel ?? null,
    };
  }

  private normalizeInboxText(text: string | null | undefined): string {
    return (text ?? '').replace(/\s+/g, ' ').trim();
  }

  private facebookSendErrorMessage(e: unknown): string {
    const msg = String((e as Error)?.message ?? e ?? '');
    if (/outside the allowed window|24 hour/i.test(msg)) {
      return 'Facebook chỉ cho trả lời trong 24 giờ sau tin nhắn của khách. Đợi khách nhắn lại rồi gửi.';
    }
    if (/permission|not authorized|#200|pages_messaging/i.test(msg)) {
      return 'Page chưa đủ quyền nhắn tin Messenger. Kiểm tra lại quyền pages_messaging.';
    }
    if (/invalid user|does not exist|#100/i.test(msg)) {
      return 'PSID khách không hợp lệ hoặc hội thoại mất liên kết Facebook.';
    }
    return msg.trim() || 'Gửi tin Facebook thất bại';
  }

  private async ensureFbConversationLinked<
    T extends {
      id: string;
      pageId: string;
      fbConversationId: string | null;
      participantPsid: string | null;
    },
  >(conv: T): Promise<T> {
    if (conv.fbConversationId || !conv.participantPsid?.trim()) return conv;
    const config = await this.prisma.facebookCskhConfig.findUnique({
      where: { pageId: conv.pageId },
      select: { pageAccessToken: true },
    });
    if (!config?.pageAccessToken) return conv;
    const fbId = await this.graph.fetchConversationIdByPsid(
      conv.pageId,
      config.pageAccessToken,
      conv.participantPsid,
    );
    if (!fbId) return conv;
    await this.prisma.cskhInboxConversation.update({
      where: { id: conv.id },
      data: { fbConversationId: fbId },
    });
    return { ...conv, fbConversationId: fbId };
  }

  private runDeepHistory(
    conv: { id: string; pageId: string; fbConversationId: string },
    token: string,
    tenantId?: string,
  ): Promise<void> {
    const existing = this.inflightDeepHistory.get(conv.id);
    if (existing) return existing;
    const run = this.refreshConversationMessages(
      conv.id,
      conv.pageId,
      conv.fbConversationId,
      token,
      this.historyMsgLimit,
      tenantId,
      { bypassHotGuard: true },
    )
      .then(() => undefined)
      .finally(() => {
        if (this.inflightDeepHistory.get(conv.id) === run) this.inflightDeepHistory.delete(conv.id);
      });
    this.inflightDeepHistory.set(conv.id, run);
    this.lastDeepHistory.set(conv.id, Date.now());
    return run;
  }

  private async findPendingOutboundToLink(
    conversationId: string,
    text?: string,
    sentAt?: Date,
  ) {
    const now = sentAt?.getTime() ?? Date.now();
    const pendings = await this.prisma.cskhInboxMessage.findMany({
      where: {
        conversationId,
        fbMessageId: null,
        direction: 'outbound',
        senderType: 'staff',
        sentAt: {
          gte: new Date(now - 90_000),
          lte: new Date(now + 15_000),
        },
      },
      orderBy: { sentAt: 'desc' },
      take: 8,
    });
    if (!pendings.length) return null;
    const want = this.normalizeInboxText(text);
    if (!want) return pendings[0];
    return (
      pendings.find((p) => this.normalizeInboxText(p.text) === want) ??
      (pendings.length === 1 ? pendings[0] : null)
    );
  }

  private publishMessageRealtime(
    pageId: string,
    conversationId: string,
    messages: CskhInboxMessage[],
    analyzeIntent = false,
    tenantId?: string,
    conversation?: CskhInboxConversation | InboxConversationAccess,
  ): void {
    if (!messages.length) return;
    const startPublish = Date.now();
    const last = messages[messages.length - 1];
    this.logger.log(`[Realtime Publish Start] messagesCount=${messages.length} conversationId=${conversationId}`);
    const publishTrace = inboxRtTraceStart('publish-realtime', {
      conversationId,
      pageId,
      messageCount: messages.length,
      messagePreview: last.text?.slice(0, 80),
      sentAt: last.sentAt?.toISOString?.() ?? String(last.sentAt),
      hasConversationRow: Boolean(conversation),
    });

    void (async () => {
      const freshConv =
        conversation ||
        (await this.prisma.cskhInboxConversation.findUnique({
          where: { id: conversationId },
        }));
      const dbLookupMs = Date.now() - startPublish;
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
      const publishMs = Date.now() - startPublish;
      this.logger.log(
        `[Realtime Publish Done] conversationId=${conversationId} took ${publishMs}ms`,
      );
      inboxRtTraceDone(publishTrace, {
        conversationId,
        dbLookupMs,
        publishMs,
        lastMessageAt: convPayload?.lastMessageAt ?? null,
        tenantId: finalTenantId ?? null,
      });

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
    const trace = inboxRtTraceStart('webhook-payload', {
      redisQueue: this.redisQueue.isRedisQueueEnabled(),
    });
    const body = payload as {
      object?: string;
      entry?: Array<{
        id?: string;
        messaging?: WebhookMessagingEvent[];
      }>;
    };
    if ((body.object !== 'page' && body.object !== 'instagram') || !Array.isArray(body.entry)) {
      return { ok: true };
    }

    let eventCount = 0;
    let inlineCount = 0;
    for (const entry of body.entry) {
      const pageId = String(entry.id || '');
      if (!pageId) continue;
      for (const event of entry.messaging ?? []) {
        eventCount++;
        // Luôn lưu DB inline — Redis queue chỉ là tùy chọn, không được chặn luồng chính.
        this.scheduleWebhookIngestInline(pageId, event);
        inlineCount++;
      }
    }
    this.logger.log(
      `[Webhook] ${eventCount} events (inline=${inlineCount}, redis=${this.redisQueue.isRedisQueueEnabled() ? 'on' : 'off'}), ${Date.now() - startWebhook}ms`,
    );
    inboxRtTraceDone(trace, { eventCount, inlineCount, ackMs: Date.now() - startWebhook });
    return { ok: true };
  }

  /** Lưu tin webhook vào DB ngay — fallback khi Redis/worker không dùng được. */
  private scheduleWebhookIngestInline(pageId: string, event: WebhookMessagingEvent): void {
    if (this.inlineWebhookInflight >= this.maxInlineWebhook) {
      this.logger.warn(
        `[Webhook] inline backlog ${this.inlineWebhookInflight}/${this.maxInlineWebhook} — vẫn xử lý (không bỏ event)`,
      );
    }
    this.inlineWebhookInflight++;
    void this.ingestMessagingEvent(pageId, event)
      .catch((err) => {
        this.logger.error(
          `Failed to ingest webhook messaging event page=${pageId}: ${err.message}`,
          err.stack,
        );
      })
      .finally(() => {
        this.inlineWebhookInflight = Math.max(0, this.inlineWebhookInflight - 1);
      });
  }

  async ingestMessagingEvent(pageId: string, event: WebhookMessagingEvent) {
    const startIngest = Date.now();
    // Meta gửi optin (đăng ký nhận thông báo) — không phải tin nhắn, bỏ qua sớm.
    if ((event as { optin?: unknown }).optin) {
      this.logger.debug(`[Webhook] optin page=${pageId} — bỏ qua`);
      return;
    }
    if (this.redisQueue.isRedisQueueEnabled()) {
      await this.redisQueue.markInboxActivity();
    }
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
    const trace = inboxRtTraceStart('webhook-message', {
      pageId,
      senderPsid,
      fbMid: msg.mid ?? null,
      textPreview: (msg.text ?? '').slice(0, 80),
      fbTimestamp: event.timestamp ?? null,
      isEcho,
      redisQueue: this.redisQueue.isRedisQueueEnabled(),
    });

    const config = await this.getCachedPageConfig(pageId);
    inboxRtTraceMark(trace, 'page-config-loaded', { pageName: config?.pageName ?? null });
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

    const webhookAttachments = msg.attachments ?? [];
    const listPreview = inboxListPreview({
      text: msg.text,
      messageType: webhookAttachments[0]?.type,
      attachmentCount: webhookAttachments.length,
    });

    const conv = await this.prisma.cskhInboxConversation.upsert({
      where: { pageId_participantPsid: { pageId, participantPsid: customerPsid } },
      create: {
        pageId,
        pageName,
        participantPsid: customerPsid,
        customerName: customerName || 'Khách hàng Messenger',
        customerPictureUrl,
        lastMessage: listPreview || msg.text || '[Ảnh]',
        lastMessageAt: new Date(event.timestamp ?? Date.now()),
        unreadCount: isFromPage ? 0 : 1,
        tenantId: config?.tenantId || null,
      },
      update: {
        pageName: pageName ?? undefined,
        customerName: customerName ?? undefined,
        customerPictureUrl: customerPictureUrl ?? undefined,
        lastMessage: listPreview || undefined,
        lastMessageAt: new Date(event.timestamp ?? Date.now()),
        unreadCount: isFromPage ? 0 : { increment: 1 },
        tenantId: config?.tenantId || undefined,
      },
    });
    inboxRtTraceMark(trace, 'conversation-upserted', {
      conversationId: conv.id,
      customerName: conv.customerName,
      lastMessageAt: conv.lastMessageAt?.toISOString() ?? null,
      unreadCount: conv.unreadCount,
    });

    // Lấy avatar/tên nếu hội thoại mới hoặc chưa có ảnh
    if ((!existingConv?.customerPictureUrl || !existingConv?.customerName) && config?.pageAccessToken) {
      void this.enrichNewConversationProfile(conv.id, customerPsid, config.pageAccessToken).catch((e) => {
        this.logger.warn(`Background profile enrichment failed: ${(e as Error).message}`);
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
        inboxRtTraceDone(trace, { conversationId: conv.id, path: 'duplicate-fb-mid' });
        return;
      }
    }

    const text = (msg.text ?? '').trim();
    if (text && this.graph.isStoredMessageNoise(text)) return;

    const sentAt = new Date(event.timestamp ?? Date.now());
    if (isFromPage && msg.mid) {
      const pendingMatch = await this.findPendingOutboundToLink(conv.id, text, sentAt);
      if (pendingMatch) {
        try {
          const linked = await this.prisma.cskhInboxMessage.update({
            where: { id: pendingMatch.id },
            data: { fbMessageId: msg.mid, status: 'sent' },
          });
          this.publishMessageRealtime(
            pageId,
            conv.id,
            [linked],
            false,
            conv.tenantId || undefined,
            conv,
          );
          inboxRtTraceDone(trace, { conversationId: conv.id, path: 'echo-link-pending' });
          return;
        } catch (e) {
          if ((e as { code?: string }).code !== 'P2002') throw e;
        }
      }
    }
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
      (mediaItems.length > 1 ||
        mediaItems.some((m) => !m.url && m.messageType !== 'text' && m.messageType !== 'sticker'))
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
        const urlPath = item.url.split('?')[0];
        const sibling = await this.prisma.cskhInboxMessage.findFirst({
          where: {
            conversationId: conv.id,
            senderType: isFromPage ? 'staff' : 'customer',
            attachmentUrl: { startsWith: urlPath },
            sentAt: {
              gte: new Date(sentAt.getTime() - 10_000),
              lte: new Date(sentAt.getTime() + 10_000),
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

    const previewAfter = inboxListPreview({
      text: createdMessages[0]?.text || text,
      messageType: createdMessages[0]?.messageType || mediaItems[0]?.messageType,
      attachmentCount: createdMessages.filter((m) => m.messageType === 'image' || m.messageType === 'video').length
        || mediaItems.length,
    });
    if (previewAfter && previewAfter !== conv.lastMessage) {
      await this.prisma.cskhInboxConversation
        .update({
          where: { id: conv.id },
          data: { lastMessage: previewAfter },
        })
        .catch(() => undefined);
      conv.lastMessage = previewAfter;
    }

    await this.publishMessageRealtime(
      pageId,
      conv.id,
      createdMessages,
      createdMessages.some((m) => m.senderType === 'customer'),
      conv.tenantId || undefined,
      conv,
    );
    inboxRtTraceMark(trace, 'realtime-published', {
      conversationId: conv.id,
      messageCount: createdMessages.length,
      lastMessageAt: conv.lastMessageAt?.toISOString() ?? null,
    });

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

    inboxRtTraceDone(trace, {
      conversationId: conv.id,
      pageId,
      senderId,
      ingestMs: Date.now() - startIngest,
    });
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
    if (!existing) return;

    const resolvedAll = await this.graph.resolveAllMessageMediaUrls(fbMessageId, pageAccessToken);
    const resolvedItems = resolvedAll.length
      ? resolvedAll.map((r) => ({ url: r.url, messageType: r.messageType }))
      : [];
    if (!resolvedItems.length) {
      const resolved = await this.graph.resolveMessageMediaUrl(fbMessageId, pageAccessToken);
      if (resolved.url) {
        resolvedItems.push({ url: resolved.url, messageType: resolved.messageType ?? 'image' });
      }
    }
    if (!resolvedItems.length) return;

    const updatedPrimary = await this.prisma.cskhInboxMessage.update({
      where: { id: existing.id },
      data: {
        attachmentUrl: resolvedItems[0].url,
        messageType: resolvedItems[0].messageType,
        text: existing.text === '[Ảnh]' ? '' : existing.text,
      },
    });
    const published = [updatedPrimary];

    for (let i = 1; i < resolvedItems.length; i++) {
      const item = resolvedItems[i];
      const sibling = await this.prisma.cskhInboxMessage.findFirst({
        where: {
          conversationId,
          senderType: existing.senderType,
          attachmentUrl: { startsWith: item.url.split('?')[0] },
          sentAt: {
            gte: new Date(existing.sentAt.getTime() - 10_000),
            lte: new Date(existing.sentAt.getTime() + 10_000),
          },
        },
      });
      if (sibling) continue;
      const created = await this.prisma.cskhInboxMessage.create({
        data: {
          conversationId,
          direction: existing.direction,
          senderType: existing.senderType,
          text: '',
          messageType: item.messageType,
          attachmentUrl: item.url,
          sentAt: existing.sentAt,
          status: 'sent',
          tenantId: tenantId || existing.tenantId,
        },
      });
      published.push(created);
    }

    const preview = inboxListPreview({
      text: updatedPrimary.text,
      messageType: updatedPrimary.messageType,
      attachmentCount: published.length,
    });
    if (preview) {
      await this.prisma.cskhInboxConversation
        .update({ where: { id: conversationId }, data: { lastMessage: preview } })
        .catch(() => undefined);
    }

    this.publishMessageRealtime(
      pageId,
      conversationId,
      published,
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
      pageIds?: string[];
    },
    flags: { includeAwaitingInUnread: boolean; includeLabelFilters: boolean },
  ): Prisma.CskhInboxConversationWhereInput {
    const andClauses: Prisma.CskhInboxConversationWhereInput[] = [];
    if (pageId) andClauses.push({ pageId });
    else if (opts.pageIds && opts.pageIds.length > 0) {
      andClauses.push({ pageId: { in: opts.pageIds } });
    }
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

  private async pageIdsForGraphPlatform(
    platform: 'messenger' | 'instagram',
    tenantId?: string,
  ): Promise<string[]> {
    const rows = await this.prisma.facebookCskhConfig.findMany({
      where: tenantId ? { tenantId } : undefined,
      select: { pageId: true, metadata: true },
    });
    return rows
      .filter((r) => cskhInboxGraphPlatform(r.metadata) === platform)
      .map((r) => r.pageId);
  }

  async getConversationStats(
    pageId?: string,
    tenantId?: string,
    platform?: 'messenger' | 'instagram',
  ) {
    const cacheKey = `${tenantId ?? '__all__'}:${pageId ?? '__all__'}:${platform ?? 'all'}`;
    const cached = this.conversationStatsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.conversationStatsTtlMs) {
      return cached.data;
    }

    // Cache hết hạn: trả số cũ ngay, đếm lại nền — đừng giữ Prisma pool bằng COUNT 1.5 triệu dòng.
    if (cached) {
      this.scheduleConversationStatsRefresh(cacheKey, pageId, tenantId, platform);
      return cached.data;
    }

    try {
      const result = await this.computeConversationStats(pageId, tenantId, platform);
      this.conversationStatsCache.set(cacheKey, { at: Date.now(), data: result });
      return result;
    } catch (e) {
      const msg = (e as Error).message || '';
      this.logger.warn(`[getConversationStats] ${msg.slice(0, 160)} — trả 0, không 500 pool`);
      return { total: 0, fromAd: 0, unread: 0, normal: 0 };
    }
  }

  private scheduleConversationStatsRefresh(
    cacheKey: string,
    pageId?: string,
    tenantId?: string,
    platform?: 'messenger' | 'instagram',
  ) {
    if (this.conversationStatsRefreshing.has(cacheKey)) return;
    this.conversationStatsRefreshing.add(cacheKey);
    void this.computeConversationStats(pageId, tenantId, platform)
      .then((result) => {
        this.conversationStatsCache.set(cacheKey, { at: Date.now(), data: result });
      })
      .catch((e) => {
        this.logger.warn(
          `[getConversationStats] ${String((e as Error).message || e).slice(0, 160)} — giữ cache cũ`,
        );
      })
      .finally(() => this.conversationStatsRefreshing.delete(cacheKey));
  }

  private async computeConversationStats(
    pageId?: string,
    tenantId?: string,
    platform?: 'messenger' | 'instagram',
  ) {
    let pageIds: string[] | undefined;
    if (pageId) {
      pageIds = [pageId];
    } else if (platform) {
      pageIds = await this.pageIdsForGraphPlatform(platform, tenantId);
      if (!pageIds.length) return { total: 0, fromAd: 0, unread: 0, normal: 0 };
    }

    try {
      return await this.countConversationStatsTimed(tenantId, pageIds);
    } catch (e) {
      if (!pageId && !platform) {
        const total = await this.estimateInboxConversationRows();
        return { total, fromAd: 0, unread: 0, normal: total };
      }
      throw e;
    }
  }

  private async estimateInboxConversationRows(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT GREATEST(c.reltuples, 0)::bigint AS n
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'cskh_inbox_conversations'
      LIMIT 1
    `;
    return Number(rows[0]?.n ?? 0);
  }

  private async countConversationStatsTimed(
    tenantId?: string,
    pageIds?: string[],
  ): Promise<{ total: number; fromAd: number; unread: number; normal: number }> {
    const filters: Prisma.Sql[] = [];
    if (tenantId) filters.push(Prisma.sql`AND tenant_id = ${tenantId}::uuid`);
    if (pageIds?.length === 1) {
      filters.push(Prisma.sql`AND page_id = ${pageIds[0]}`);
    } else if (pageIds && pageIds.length > 1) {
      filters.push(Prisma.sql`AND page_id IN (${Prisma.join(pageIds)})`);
    }
    const whereSql = filters.length ? Prisma.join(filters, ' ') : Prisma.empty;

    const run = async (unreadExpr: Prisma.Sql) =>
      this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '2000ms'`);
          return tx.$queryRaw<Array<{ total: bigint; from_ad: bigint; unread: bigint }>>`
            SELECT
              COUNT(*)::bigint AS total,
              COUNT(*) FILTER (WHERE from_ad)::bigint AS from_ad,
              COUNT(*) FILTER (WHERE ${unreadExpr})::bigint AS unread
            FROM cskh_inbox_conversations
            WHERE 1=1 ${whereSql}
          `;
        },
        { maxWait: 3_000, timeout: 4_000 },
      );

    let rows: Array<{ total: bigint; from_ad: bigint; unread: bigint }>;
    try {
      rows = await run(Prisma.sql`unread_count > 0 OR awaiting_label`);
    } catch (e) {
      if (!this.isInboxSchemaMigrationError(e)) throw e;
      this.logger.warn('[getConversationStats] awaiting_label chưa migrate — fallback unreadCount');
      rows = await run(Prisma.sql`unread_count > 0`);
    }

    const row = rows[0];
    const total = Number(row?.total ?? 0);
    const fromAd = Number(row?.from_ad ?? 0);
    const unread = Number(row?.unread ?? 0);
    return { total, fromAd, unread, normal: Math.max(0, total - fromAd) };
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
      platform?: 'messenger' | 'instagram';
    },
  ): Promise<{ items: CskhInboxConversation[]; nextCursor: string | null; hasMore: boolean }> {
    this.touchUserActivity(pageId);
    let platformPageIds: string[] | undefined;
    if (!pageId && opts?.platform) {
      platformPageIds = await this.pageIdsForGraphPlatform(opts.platform, tenantId);
      if (!platformPageIds.length) {
        return { items: [], nextCursor: null, hasMore: false };
      }
    }
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
      pageIds: platformPageIds,
    };

    if (!isScrollPage && !hasListFilter) {
      if (isCskhWorkerProcess()) {
        const redisOff = !this.redisQueue.isRedisQueueEnabled();
        if (!redisOff && !this.backgroundInboxSyncRunning) {
          void this.maybeBackfillAdReferralsFromDb(tenantId).catch((e) => {
            this.logger.warn(`Ad referral backfill failed: ${(e as Error).message}`);
          });
        }
      }
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
      if (isPrismaRetryableDbError(e)) {
        this.logger.warn(
          `[listConversations] DB timeout/pool — trả list rỗng, không 500: ${String((e as Error).message || e).slice(0, 160)}`,
        );
        return { items: [], nextCursor: null, hasMore: false };
      }
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
        : await this.correctUnreadFromLastMessage(slice as CskhInboxConversation[]).catch((e) => {
            if (isPrismaRetryableDbError(e)) return slice as CskhInboxConversation[];
            throw e;
          });
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
        if (!this.isInboxSchemaMigrationError(e) && !isPrismaRetryableDbError(e)) throw e;
      }
    }

    const itemsWithLabels = items.map((i) => ({
      ...i,
      labels: needLabels ? (labelMap.get(i.id) ?? []) : [],
      labelsLocked: needLabels ? (labelMap.get(i.id) ?? []).length > 0 : false,
    }));

    const missingPictureIds = itemsWithLabels
      .filter((i) => !i.customerPictureUrl && i.participantPsid)
      .slice(0, 3)
      .map((i) => i.id);
    if (missingPictureIds.length && !this.avatarEnrichRunning) {
      this.avatarEnrichRunning = true;
      void this.enrichCustomerPictures(missingPictureIds)
        .catch((e) => {
          this.logger.debug(`Background avatar enrich failed: ${(e as Error).message}`);
        })
        .finally(() => {
          this.avatarEnrichRunning = false;
        });
    }

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
    if (this.backgroundInboxSyncRunning) {
      return { updated: 0 };
    }
    if (await this.redisQueue.shouldDeferInboxSync()) {
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
    if (!isCskhWorkerProcess()) return;
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
    if (isPrismaRecentlyBusy(20_000)) return;
    // Page đang xem: luôn quét Graph nhẹ (webhook app mới / Dev mode hay hỏng thì list vẫn lên tin mới).
    if (pageId) {
      const syncKey = `${pageId}:${tenantId ?? ''}`;
      const lastSync = this.lastListSync.get(syncKey) ?? 0;
      if (Date.now() - lastSync < this.listSyncCooldownMs) return;
      this.lastListSync.set(syncKey, Date.now());
      void this.syncFromGraph(pageId, tenantId, { lightweight: true, liveHead: true }).catch((e) => {
        this.logger.warn(`[list-sync] page ${pageId}: ${(e as Error).message}`);
      });
      return;
    }

    const redisOff = !this.redisQueue.isRedisQueueEnabled();
    if (!this.rotatingSyncEnabled && !redisOff) return;

    if (redisOff) {
      await this.maybeCatchUpSyncWithoutRedis(pageId, tenantId);
      return;
    }

    await this.maybeRotatingSyncAllPages(tenantId);
  }

  /**
   * Redis/worker tắt — quét nhẹ vài page từ Graph để bù tin webhook bị mất (Meta không retry mãi).
   */
  private async maybeCatchUpSyncWithoutRedis(pageId?: string, tenantId?: string): Promise<void> {
    if (this.backgroundInboxSyncRunning) return;
    if (pageId) {
      const syncKey = `${pageId}:${tenantId ?? ''}`;
      const lastSync = this.lastListSync.get(syncKey) ?? 0;
      if (Date.now() - lastSync < this.redisOffListSyncCooldownMs) return;
      this.lastListSync.set(syncKey, Date.now());
      this.logger.log(`[catch-up-sync] Redis off — quét nhẹ page ${pageId}`);
      await this.syncFromGraph(pageId, tenantId, { lightweight: true });
      return;
    }
    await this.maybeRotatingSyncAllPages(tenantId, { forceWithoutRedis: true });
  }

  /**
   * Poll Graph nhẹ ~3s: 1 request / page, chỉ đầu list hội thoại mới nhất.
   * Webhook vẫn là đường tức thì; đây bù khi Meta chưa đẩy event.
   */
  async runLiveGraphCatchUp(tenantId?: string): Promise<void> {
    if (isPrismaRecentlyBusy(20_000)) return;
    if (this.liveCatchUpRunning || this.backgroundInboxSyncRunning) return;
    if (this.graphCoordinator.inboxSyncActive) return;
    if (Date.now() < this.catchUpBackoffUntil) return;
    if (await this.isAuditJobRunning(tenantId)) return;
    if (!(await this.redisQueue.tryLiveCatchUpLock(2))) return;

    const pages = await this.findLiveCatchUpPages(tenantId);
    if (!pages.length) return;

    this.liveCatchUpRunning = true;
    try {
      let synced = 0;
      for (const page of pages) {
        if (!page.pageAccessToken) continue;
        try {
          synced += await this.syncSinglePageFromGraph(page, false, true, { liveHead: true });
        } catch (e) {
          this.logger.warn(
            `[catch-up] Lỗi page ${page.pageName || page.pageId}: ${(e as Error).message}`,
          );
        }
      }
      if (synced > 0) {
        this.logger.log(
          `[catch-up] +${synced} tin mới (${pages.map((p) => p.pageName || p.pageId).join(', ')})`,
        );
      }
    } finally {
      this.liveCatchUpRunning = false;
    }
  }

  private async findLiveCatchUpPages(tenantId?: string): Promise<FacebookCskhConfig[]> {
    const viewedId =
      this.liveViewedPageId || (await this.redisQueue.getViewedInboxPage()) || null;

    const allPages = await this.prisma.facebookCskhConfig.findMany({
      where: {
        pageAccessToken: { not: '' },
        ...(tenantId ? { tenantId } : {}),
      },
      orderBy: { pageName: 'asc' },
    });
    if (!allPages.length) return [];

    const recent = await this.prisma.cskhInboxConversation.findMany({
      where: tenantId ? { tenantId } : {},
      orderBy: { lastMessageAt: 'desc' },
      select: { pageId: true },
      take: 40,
    });
    const hotIds: string[] = [];
    if (viewedId) hotIds.push(viewedId);
    for (const row of recent) {
      if (!hotIds.includes(row.pageId)) hotIds.push(row.pageId);
      if (hotIds.length >= Math.max(this.catchUpHotPages, viewedId ? 2 : 1)) break;
    }

    const byId = new Map(allPages.map((p) => [p.pageId, p]));
    const selected: FacebookCskhConfig[] = [];
    for (const id of hotIds) {
      const page = byId.get(id);
      if (page) selected.push(page);
    }

    if (!selected.length) {
      return allPages.slice(0, 1);
    }
    return selected;
  }

  private async isAuditJobRunning(tenantId?: string): Promise<boolean> {
    if (Date.now() - this.auditRunningCache.at < 15_000) {
      return this.auditRunningCache.value;
    }
    try {
      const running = await this.prisma.cskhJobRun.findFirst({
        where: {
          type: 'audit',
          status: 'running',
          ...(tenantId ? { tenantId } : {}),
        },
        select: { id: true },
      });
      this.auditRunningCache = { at: Date.now(), value: !!running };
      return !!running;
    } catch (e) {
      const msg = (e as Error).message || '';
      if (/connection pool|Timed out fetching/i.test(msg)) {
        this.catchUpBackoffUntil = Date.now() + 20_000;
      }
      this.auditRunningCache = { at: Date.now(), value: false };
      return false;
    }
  }

  /**
   * Xem "Tất cả Page": quét luân phiên vài page/lần (~45s) để bắt tin mới mà không quét 87 page cùng lúc.
   */
  private async maybeRotatingSyncAllPages(
    tenantId?: string,
    opts?: { forceWithoutRedis?: boolean },
  ): Promise<void> {
    const redisOff = opts?.forceWithoutRedis === true || !this.redisQueue.isRedisQueueEnabled();
    if (this.backgroundInboxSyncRunning) return;
    const cooldownMs = redisOff ? this.redisOffSyncCooldownMs : this.allPagesSyncCooldownMs;
    if (Date.now() - this.lastAllPagesRotatingSync < cooldownMs) return;
    if (await this.isAuditJobRunning(tenantId)) return;
    if (!redisOff && (await this.redisQueue.isInboxSyncActive())) return;
    if (!redisOff && (await this.redisQueue.getWebhookQueueDepth()) > 0) return;

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
    const batchCap = redisOff ? this.redisOffSyncBatch : this.allPagesSyncBatch;
    const batchSize = Math.min(Math.max(batchCap, 1), pages.length);
    const batch: typeof pages = [];
    for (let i = 0; i < batchSize; i++) {
      batch.push(pages[(this.allPagesSyncCursor + i) % pages.length]);
    }
    this.allPagesSyncCursor = (this.allPagesSyncCursor + batchSize) % pages.length;

    this.logger.log(
      `[rotating-sync] Quét ${batch.length}/${pages.length} page (bắt đầu từ ${batch[0]?.pageName || batch[0]?.pageId})${redisOff ? ' [redis-off]' : ''}`,
    );

    this.backgroundInboxSyncRunning = true;
    this.graphCoordinator.beginInboxSync();
    await this.redisQueue.markInboxSyncActive();
    try {
      for (const page of batch) {
        if (!redisOff && (await this.redisQueue.getWebhookQueueDepth()) > 0) {
          this.logger.log('[rotating-sync] Dừng — webhook đang có event');
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
      this.backgroundInboxSyncRunning = false;
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
    beforeDate?: Date,
  ): Promise<InboxMessageRow[]> {
    const hasSince = sinceDate && !Number.isNaN(sinceDate.getTime());
    const hasBefore = beforeDate && !Number.isNaN(beforeDate.getTime());
    const withLegacyNulls = (
      rows: Array<{
        id: string;
        conversationId: string;
        fbMessageId: string | null;
        direction: string;
        senderType: string;
        text: string;
        messageType: string;
        attachmentUrl: string | null;
        sentAt: Date;
        status: string;
      }>,
    ): InboxMessageRow[] =>
      rows.map((r) => ({
        ...r,
        originalText: null,
        translatedText: null,
        sourceLang: null,
      }));

    try {
      if (hasBefore) {
        const rows = await this.prisma.cskhInboxMessage.findMany({
          where: { conversationId, sentAt: { lt: beforeDate! } },
          orderBy: { sentAt: 'desc' },
          take: fetchLimit,
          select: INBOX_MESSAGE_SELECT,
        });
        return rows.reverse();
      }
      if (hasSince) {
        return await this.prisma.cskhInboxMessage.findMany({
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
    } catch (e) {
      if (!isInboxSchemaMigrationError(e)) throw e;
      this.logger.warn(
        `loadConversationMessages fallback legacy select (chạy manual-inbox-translate.sql): ${(e as Error).message}`,
      );
      if (hasBefore) {
        const rows = await this.prisma.cskhInboxMessage.findMany({
          where: { conversationId, sentAt: { lt: beforeDate! } },
          orderBy: { sentAt: 'desc' },
          take: fetchLimit,
          select: INBOX_MESSAGE_SELECT_LEGACY,
        });
        return withLegacyNulls(rows.reverse());
      }
      if (hasSince) {
        const rows = await this.prisma.cskhInboxMessage.findMany({
          where: { conversationId, sentAt: { gt: sinceDate! } },
          orderBy: { sentAt: 'asc' },
          take: 100,
          select: INBOX_MESSAGE_SELECT_LEGACY,
        });
        return withLegacyNulls(rows);
      }
      const rows = await this.prisma.cskhInboxMessage.findMany({
        where: { conversationId },
        orderBy: { sentAt: 'desc' },
        take: fetchLimit,
        select: INBOX_MESSAGE_SELECT_LEGACY,
      });
      return withLegacyNulls(rows.reverse());
    }
  }

  private async enrichCustomerPictures(conversationIds: string[]) {
    const convs = await this.prisma.cskhInboxConversation.findMany({
      where: { id: { in: conversationIds } },
    });
    for (const conv of convs) {
      const config = await this.prisma.facebookCskhConfig.findUnique({
        where: { pageId: conv.pageId },
      });
      if (!config?.pageAccessToken) continue;
      if (conv.customerPictureUrl?.startsWith('http')) continue;
      try {
        const profile = await this.graph.getMessengerUserProfile(
          conv.participantPsid,
          config.pageAccessToken,
          { platform: cskhInboxGraphPlatform(config.metadata) },
        );
        if (!profile.pictureUrl && !profile.name) continue;
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
    }
  }

  private async enrichNewConversationProfile(
    conversationId: string,
    customerPsid: string,
    pageAccessToken: string,
  ) {
    try {
      const convRow = await this.prisma.cskhInboxConversation.findUnique({
        where: { id: conversationId },
        select: { pageId: true },
      });
      const pageMeta = convRow?.pageId
        ? await this.prisma.facebookCskhConfig.findUnique({
            where: { pageId: convRow.pageId },
            select: { metadata: true },
          })
        : null;
      const profile = await this.graph.getMessengerUserProfile(customerPsid, pageAccessToken, {
        platform: cskhInboxGraphPlatform(pageMeta?.metadata),
      });
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
    viewerUserId?: bigint | number,
    before?: string,
  ) {
    this.touchUserActivity();

    const fetchLimit = limit
      ? Math.min(Math.max(Math.floor(limit), 10), this.historyMsgLimit)
      : this.msgLimit;

    const sinceDate = since ? new Date(since) : undefined;
    const beforeDate = before ? new Date(before) : undefined;

    const labelsPromise = this.inboxLabels
      .getLabelsForConversation(conversationId)
      .catch((e) => {
        if (this.isInboxSchemaMigrationError(e) || isPrismaRetryableDbError(e)) return [] as InboxLabelDto[];
        throw e;
      });

    let conv: Awaited<ReturnType<typeof findInboxConversationById>> = null;
    let messages: Awaited<ReturnType<typeof this.loadConversationMessages>> = [];

    try {
      [conv, messages] = await Promise.all([
        findInboxConversationById(this.prisma, conversationId, tenantId),
        this.loadConversationMessages(conversationId, sinceDate, fetchLimit, beforeDate),
      ]);
    } catch (e) {
      if (isPrismaRetryableDbError(e)) {
        this.logger.warn(
          `getMessages pool busy conv=${conversationId.slice(0, 8)} — 503, không 500/404 giả`,
        );
        throw new ServiceUnavailableException('Hệ thống đang bận. Thử lại sau vài giây.');
      }
      throw e;
    }

    if (!conv) throw new NotFoundException('Hội thoại không tồn tại hoặc không có quyền');
    this.touchUserActivity(conv.pageId);

    conv = await this.ensureFbConversationLinked(conv);

    const hasSince = sinceDate && !Number.isNaN(sinceDate.getTime());
    const hasBefore = beforeDate && !Number.isNaN(beforeDate.getTime());
    if (conv.fbConversationId && conv.participantPsid) {
      const previewMismatch =
        !hasSince && !hasBefore && lastMessagePreviewMismatch(conv.lastMessage, messages);
      const needsReconcile =
        !hasSince && !hasBefore && (previewMismatch || messages.length === 0 || forceRefresh);
      if (needsReconcile) {
        this.lastReconcileRead.set(conversationId, Date.now());
        const reconcileTask = this.syncReconcileConversationMessages(
          conv,
          fetchLimit,
          tenantId,
        );
        if (messages.length === 0 || previewMismatch) {
          await reconcileTask;
          messages = await this.loadConversationMessages(conversationId, sinceDate, fetchLimit, beforeDate);
        } else {
          void reconcileTask.catch((e) => {
            this.logger.debug(
              `getMessages reconcile background conv=${conversationId.slice(0, 8)}: ${(e as Error).message}`,
            );
          });
        }
      }

      const lastGraph = this.lastGraphRefresh.get(conversationId) ?? 0;
      const graphCooled = Date.now() - lastGraph >= this.graphRefreshCooldownMs;
      const needOlderFromGraph = hasBefore && messages.length < Math.min(fetchLimit, 8);
      const mustAwaitGraph =
        (!hasSince && !hasBefore && (messages.length === 0 || previewMismatch)) || needOlderFromGraph;
      const shouldGraphRefresh = mustAwaitGraph || (forceRefresh && graphCooled);
      const fbConversationId = conv.fbConversationId;

      if ((shouldGraphRefresh || needOlderFromGraph) && fbConversationId) {
        const config = await this.prisma.facebookCskhConfig.findUnique({
          where: { pageId: conv.pageId },
          select: { pageAccessToken: true },
        });
        if (config?.pageAccessToken) {
          if (needOlderFromGraph) {
            await this.runDeepHistory(
              { id: conv.id, pageId: conv.pageId, fbConversationId },
              config.pageAccessToken,
              tenantId,
            );
            messages = await this.loadConversationMessages(
              conversationId,
              sinceDate,
              fetchLimit,
              beforeDate,
            );
          } else {
            this.lastGraphRefresh.set(conversationId, Date.now());
            const refreshTask = this.refreshConversationMessages(
              conv.id,
              conv.pageId,
              fbConversationId,
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
                beforeDate,
              );
            } else {
              void refreshTask.catch((e) => {
                this.logger.warn(
                  `getMessages background sync failed conv=${conversationId.slice(0, 8)}: ${(e as Error).message}`,
                );
              });
            }
            const lastDeep = this.lastDeepHistory.get(conversationId) ?? 0;
            if (Date.now() - lastDeep >= this.deepHistoryCooldownMs) {
              void this.runDeepHistory(
                { id: conv.id, pageId: conv.pageId, fbConversationId },
                config.pageAccessToken,
                tenantId,
              ).catch((e) => {
                this.logger.debug(
                  `getMessages deep history conv=${conversationId.slice(0, 8)}: ${(e as Error).message}`,
                );
              });
            }
          }
        }
      } else if (!hasSince && !hasBefore && fbConversationId) {
        const lastDeep = this.lastDeepHistory.get(conversationId) ?? 0;
        if (Date.now() - lastDeep >= this.deepHistoryCooldownMs) {
          const config = await this.prisma.facebookCskhConfig.findUnique({
            where: { pageId: conv.pageId },
            select: { pageAccessToken: true },
          });
          if (config?.pageAccessToken) {
            void this.runDeepHistory(
              { id: conv.id, pageId: conv.pageId, fbConversationId },
              config.pageAccessToken,
              tenantId,
            ).catch((e) => {
              this.logger.debug(
                `getMessages deep history conv=${conversationId.slice(0, 8)}: ${(e as Error).message}`,
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

    const filtered = (messages ?? []).filter((m) => !this.graph.isStoredMessageNoise(m.text));
    this.ensureMessageTranslations(conv, filtered, tenantId);

    return {
      conversation: {
        ...conv,
        unreadCount: 0,
        awaitingLabel,
        labels,
        viewers: [],
        labelsLocked: hasLabels,
      },
      messages: filtered,
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
    if (!options?.bypassHotGuard && (await this.redisQueue.shouldDeferInboxSync())) {
      return;
    }
    try {
      const convRow = await this.prisma.cskhInboxConversation.findUnique({
        where: { id: conversationId },
        select: { participantPsid: true },
      });
      const customerPsid = convRow?.participantPsid ?? undefined;

      const cap = Math.max(this.auditRecheckMsgLimit, this.historyMsgLimit);
      const safeLimit = Math.min(Math.max(msgLimit, 10), cap);
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
        Math.min(safeLimit, this.msgLimit),
      );
      const liveCutoff = Date.now() - 180_000;
      const liveRows = syncedRows.filter(
        (m) => m.sentAt instanceof Date && m.sentAt.getTime() >= liveCutoff,
      );
      if (liveRows.length) {
        const freshConv = await this.prisma.cskhInboxConversation.findUnique({
          where: { id: conversationId },
        });
        this.realtime.publish({
          type: 'message',
          pageId,
          conversationId,
          messages: liveRows.slice(-20).map((m) => this.formatMessageRow(m as CskhInboxMessage)),
          conversation: freshConv ? this.formatConversationRow(freshConv) : undefined,
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
    if (await this.redisQueue.shouldDeferInboxSync()) return;
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
    const batchSize = Number(process.env.CSKH_MEDIA_BACKFILL_BATCH || 6);
    const mediaConcurrency = Number(process.env.CSKH_MEDIA_BACKFILL_CONCURRENCY || 3);
    for (let round = 0; round < 3; round++) {
      const missing = result.filter((r) => this.needsMediaBackfill(r)).slice(0, batchSize);
      if (!missing.length) break;
      let progress = false;
      let next = 0;
      const workers = Array.from({ length: Math.min(mediaConcurrency, missing.length) }, async () => {
        while (true) {
          const idx = next++;
          if (idx >= missing.length) return;
          const row = missing[idx];
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
            const resultIdx = result.findIndex((r) => r.id === row.id);
            if (resultIdx >= 0) {
              result[resultIdx] = {
                ...result[resultIdx],
                attachmentUrl: resolved.url,
                messageType: resolved.messageType ?? row.messageType,
                text: newText,
              };
            }
            this.publishMessageRealtime(pageId, conversationId, [updated]);
          } catch (e) {
            this.logger.debug(
              `backfillMissingMediaUrls ${row.id}: ${(e as Error).message}`,
            );
          }
        }
      });
      await Promise.all(workers);
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
      Boolean(token && enriched.id) &&
      (attCount >= 1 ||
        normalized.messageType === 'image' ||
        normalized.messageType === 'video');
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
      if (!exists && isStaff) {
        exists = await this.findPendingOutboundToLink(conversationId, normalized.text, sentAt);
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
        return {
          text: inboxListPreview({
            text: normalized.text,
            messageType: normalized.messageType,
            attachmentCount: 0,
          }) || normalized.text,
        };
      }
      try {
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
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e;
      }
      return {
        text: inboxListPreview({
          text: normalized.text,
          messageType: normalized.messageType,
          attachmentCount: 0,
        }) || normalized.text,
      };
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
        const urlPath = attachmentUrl.split('?')[0];
        exists = await this.prisma.cskhInboxMessage.findFirst({
          where: {
            conversationId,
            senderType: isStaff ? 'staff' : 'customer',
            attachmentUrl: { startsWith: urlPath },
            sentAt: {
              gte: new Date(sentAt.getTime() - 10_000),
              lte: new Date(sentAt.getTime() + 10_000),
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

    return {
      text:
        inboxListPreview({
          text: normalized.text,
          messageType: normalized.messageType,
          attachmentCount: mediaUrls.length,
        }) || normalized.text,
    };
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

  async sendMessage(
    conversationId: string,
    text: string,
    tenantId?: string,
    options?: { autoTranslate?: boolean; originalText?: string },
  ) {
    const trimmed = text.trim();
    if (!trimmed) throw new BadRequestException('Tin nhắn trống');
    const lockKey = `${conversationId}:${trimmed}`;
    const inflight = this.inflightSends.get(lockKey);
    if (inflight) return inflight;
    const run = this.sendMessageUnlocked(conversationId, trimmed, tenantId, options);
    this.inflightSends.set(lockKey, run);
    void run.finally(() => {
      setTimeout(() => {
        if (this.inflightSends.get(lockKey) === run) this.inflightSends.delete(lockKey);
      }, 2500);
    });
    return run;
  }

  private async sendMessageUnlocked(
    conversationId: string,
    trimmed: string,
    tenantId?: string,
    options?: { autoTranslate?: boolean; originalText?: string },
  ) {

    const conv = await findInboxConversationById(this.prisma, conversationId, tenantId);
    if (!conv) throw new NotFoundException('Hội thoại không tồn tại hoặc không có quyền');

    if (!conv.participantPsid?.trim()) {
      throw new BadRequestException(
        'Thiếu PSID khách — không gửi được tin Messenger. Mở lại hội thoại để đồng bộ từ Facebook.',
      );
    }

    const config = await this.prisma.facebookCskhConfig.findFirst({
      where: tenantId ? { pageId: conv.pageId, tenantId } : { pageId: conv.pageId },
    });
    if (!config?.pageAccessToken) {
      throw new BadRequestException('Page chưa có access token');
    }

    let outboundText = trimmed;
    let originalText: string | null = null;
    let translatedText: string | null = null;
    let sourceLang: string | null = 'vi';

    const reviewedOriginal = options?.originalText?.trim() || '';
    if (reviewedOriginal && reviewedOriginal !== trimmed) {
      outboundText = trimmed;
      originalText = reviewedOriginal;
      translatedText = reviewedOriginal;
    } else if (options?.autoTranslate) {
      const langInfo = await this.resolveCustomerLang(conv, tenantId);
      const target = (langInfo.lang || '').trim().toLowerCase();
      const shouldTranslate =
        Boolean(target) &&
        target !== 'vi' &&
        target !== 'und' &&
        !this.looksLikeForeignScript(trimmed);
      if (shouldTranslate) {
        const contextMessages = await this.loadTranslateContext(conv.id);
        const tr = await this.ai.translateText({
          text: trimmed,
          sourceLang: 'vi',
          targetLang: target,
          direction: 'outbound',
          contextMessages,
        });
        const translated = tr.translatedText.trim();
        const isRewriteNotTranslate =
          translated !== trimmed &&
          this.looksLikeVietnamese(trimmed) &&
          this.looksLikeVietnamese(translated) &&
          !this.looksLikeForeignScript(translated);
        if (
          !tr.sameLanguage &&
          translated &&
          translated !== trimmed &&
          !isRewriteNotTranslate
        ) {
          outboundText = translated;
          originalText = trimmed;
          translatedText = trimmed;
          sourceLang = target;
        } else if (isRewriteNotTranslate) {
          this.logger.warn(
            `Bỏ auto-translate — AI viết lại tiếng Việt thay vì dịch (conv=${conv.id})`,
          );
        }
      }
    }

    const pending = await this.prisma.cskhInboxMessage.create({
      data: {
        conversationId: conv.id,
        direction: 'outbound',
        senderType: 'staff',
        text: outboundText,
        originalText,
        translatedText,
        sourceLang,
        status: 'pending',
        tenantId,
      },
    });

    const updatedConv = await this.prisma.cskhInboxConversation.update({
      where: { id: conv.id },
      data: {
        lastMessage: outboundText,
        lastMessageAt: new Date(),
        unreadCount: 0,
        awaitingLabel: false,
      },
    });

    this.publishMessageRealtime(conv.pageId, conv.id, [pending], false, tenantId, updatedConv);

    try {
      const result = await this.graph.sendPageMessage(
        conv.pageId,
        config.pageAccessToken,
        conv.participantPsid,
        outboundText,
      );
      try {
        const sent = await this.prisma.cskhInboxMessage.update({
          where: { id: pending.id },
          data: {
            status: 'sent',
            fbMessageId: result.message_id ?? null,
          },
        });
        this.publishMessageRealtime(conv.pageId, conv.id, [sent], false, tenantId, updatedConv);
        return this.formatMessageRow(sent);
      } catch (linkErr) {
        const code = (linkErr as { code?: string }).code;
        if (code === 'P2002' && result.message_id) {
          const linked = await this.prisma.cskhInboxMessage.findUnique({
            where: { fbMessageId: result.message_id },
          });
          if (linked && linked.id !== pending.id) {
            await this.prisma.cskhInboxMessage
              .delete({ where: { id: pending.id } })
              .catch(() => undefined);
            this.publishMessageRealtime(
              conv.pageId,
              conv.id,
              [linked],
              false,
              tenantId,
              updatedConv,
            );
            return this.formatMessageRow(linked);
          }
        }
        throw linkErr;
      }
    } catch (e) {
      this.logger.error(
        `Failed to send message to Facebook for msg ${pending.id}: ${(e as Error).message}`,
      );
      const failed = await this.prisma.cskhInboxMessage.update({
        where: { id: pending.id },
        data: { status: 'failed' },
      });
      this.publishMessageRealtime(conv.pageId, conv.id, [failed], false, tenantId, updatedConv);
      throw new BadRequestException(this.facebookSendErrorMessage(e));
    }
  }

  /** Preview dịch sang tiếng Việt (không lưu DB) — NV xem rồi mới gửi. */
  async translatePreview(
    conversationId: string,
    text: string,
    tenantId?: string,
    targetLang?: string,
  ) {
    const trimmed = text.trim();
    if (!trimmed) throw new BadRequestException('Tin nhắn trống');

    const conv = await findInboxConversationById(this.prisma, conversationId, tenantId);
    if (!conv) throw new NotFoundException('Hội thoại không tồn tại hoặc không có quyền');

    const langInfo = await this.resolveCustomerLang(conv, tenantId).catch(() => ({
      lang: conv.customerLang || 'vi',
      langLabel: conv.customerLangLabel || 'Tiếng Việt',
    }));

    const target = (targetLang?.trim() || 'vi').toLowerCase() || 'vi';
    const alreadyVi =
      target === 'vi' &&
      this.looksLikeVietnamese(trimmed) &&
      !this.looksLikeForeignScript(trimmed);

    if (alreadyVi) {
      return {
        originalText: trimmed,
        translatedText: trimmed,
        detectedLang: 'vi',
        targetLang: 'vi',
        customerLang: langInfo.lang,
        customerLangLabel: langInfo.langLabel,
        sameLanguage: true,
      };
    }

    const tr = await this.ai.translateText({
      text: trimmed,
      sourceLang: 'auto',
      targetLang: target,
      direction: 'outbound',
      contextMessages: await this.loadTranslateContext(conv.id),
    });

    const translated = (tr.translatedText || '').trim() || trimmed;
    const inputIsVi =
      this.looksLikeVietnamese(trimmed) && !this.looksLikeForeignScript(trimmed);
    const same = translated === trimmed || (target === 'vi' && inputIsVi);

    return {
      originalText: trimmed,
      translatedText: same ? trimmed : translated,
      detectedLang: tr.detectedLang,
      targetLang: target,
      customerLang: langInfo.lang,
      customerLangLabel: langInfo.langLabel,
      sameLanguage: same,
    };
  }

  /** Phát hiện + lưu ngôn ngữ khách trên conversation (BE DB). */
  async detectAndPersistCustomerLang(conversationId: string, tenantId?: string) {
    const conv = await findInboxConversationById(this.prisma, conversationId, tenantId);
    if (!conv) throw new NotFoundException('Hội thoại không tồn tại hoặc không có quyền');

    const langInfo = await this.resolveCustomerLang(conv, tenantId, true);
    return {
      customerLang: langInfo.lang,
      customerLangLabel: langInfo.langLabel,
      confidence: langInfo.confidence,
    };
  }

  /** Nút Dịch trên header — dịch cả tin khách lẫn tin shop sang tiếng Việt (await). */
  async translateConversationMessages(conversationId: string, tenantId?: string) {
    const conv = await findInboxConversationById(this.prisma, conversationId, tenantId);
    if (!conv) throw new NotFoundException('Hội thoại không tồn tại hoặc không có quyền');

    const rows = await this.prisma.cskhInboxMessage.findMany({
      where: {
        conversationId: conv.id,
        messageType: 'text',
      },
      orderBy: { sentAt: 'desc' },
      take: 80,
      select: {
        id: true,
        direction: true,
        messageType: true,
        text: true,
        originalText: true,
        translatedText: true,
      },
    });
    const translated = await this.runMessageTranslations(conv, rows.reverse(), tenantId);
    return { translated, total: rows.length };
  }

  private async resolveCustomerLang(
    conv: CskhInboxConversation | InboxConversationAccess,
    _tenantId?: string,
    forceRefresh = false,
  ): Promise<{ lang: string; langLabel: string; confidence: string }> {
    if (!forceRefresh && conv.customerLang) {
      return {
        lang: conv.customerLang,
        langLabel: conv.customerLangLabel || conv.customerLang,
        confidence: 'cached',
      };
    }

    // Lấy nhiều tin trong hội thoại (ưu tiên inbound, bổ sung outbound nếu thiếu)
    const rows = await this.prisma.cskhInboxMessage.findMany({
      where: {
        conversationId: conv.id,
        messageType: 'text',
        NOT: { text: { in: ['', '[Ảnh]', '[Video]', '[Sticker]', '[attachment]'] } },
      },
      orderBy: { sentAt: 'asc' },
      take: 120,
      select: { text: true, direction: true },
    });
    const inbound = rows.filter((m) => m.direction === 'inbound').map((m) => m.text);
    const samples = (inbound.length >= 3 ? inbound : rows.map((m) => m.text)).filter(Boolean);
    const detected = await this.ai.detectLang(samples);

    try {
      await this.prisma.cskhInboxConversation.update({
        where: { id: conv.id },
        data: {
          customerLang: detected.lang,
          customerLangLabel: detected.langLabel,
        },
      });
    } catch (e) {
      this.logger.warn(
        `persist customerLang failed (chạy manual-inbox-translate.sql?): ${(e as Error).message}`,
      );
    }

    return {
      lang: detected.lang,
      langLabel: detected.langLabel,
      confidence: detected.confidence,
    };
  }

  private async loadTranslateContext(conversationId: string): Promise<string[]> {
    const rows = await this.prisma.cskhInboxMessage.findMany({
      where: {
        conversationId,
        messageType: 'text',
        NOT: { text: { in: ['', '[Ảnh]', '[Video]', '[Sticker]', '[attachment]'] } },
      },
      orderBy: { sentAt: 'desc' },
      take: 16,
      select: { text: true, direction: true, senderType: true },
    });
    return rows
      .reverse()
      .map((m) => {
        const who = m.direction === 'inbound' || m.senderType === 'customer' ? 'Khách' : 'Shop';
        return `${who}: ${m.text.slice(0, 220)}`;
      });
  }

  /**
   * Dịch thiếu bản VI cho inbound + outbound.
   * Tối ưu: skip VI heuristic → batch LLM (1 call/~12 tin) → SSE từng batch (ưu tiên tin mới).
   */
  private ensureMessageTranslations(
    conv: CskhInboxConversation | InboxConversationAccess,
    messages: Array<
      Pick<CskhInboxMessage, 'id' | 'direction' | 'messageType' | 'text'> & {
        translatedText?: string | null;
        originalText?: string | null;
      }
    >,
    tenantId?: string,
  ): void {
    void this.runMessageTranslations(conv, messages, tenantId);
  }

  private async runMessageTranslations(
    conv: CskhInboxConversation | InboxConversationAccess,
    messages: Array<
      Pick<CskhInboxMessage, 'id' | 'direction' | 'messageType' | 'text'> & {
        translatedText?: string | null;
        originalText?: string | null;
      }
    >,
    tenantId?: string,
  ): Promise<number> {
    const noise = new Set(['[Ảnh]', '[Video]', '[Sticker]', '[attachment]']);
    const need = messages.filter((m) => {
      if (m.messageType !== 'text' || !m.text?.trim() || noise.has(m.text)) return false;
      const vi = (m.originalText || m.translatedText || '').trim();
      if (this.looksLikeForeignScript(m.text)) {
        return !vi || vi === m.text.trim() || this.looksLikeForeignScript(vi);
      }
      return !vi;
    });
    if (!need.length) return 0;

    const prioritized = [...need].reverse().slice(0, 48);

    const contextMessages = messages
      .filter((m) => m.messageType === 'text' && m.text?.trim() && !noise.has(m.text))
      .slice(-16)
      .map((m) => {
        const who = m.direction === 'inbound' ? 'Khách' : 'Shop';
        return `${who}: ${m.text.slice(0, 180)}`;
      });

    let translated = 0;
    const needAi: typeof prioritized = [];
    const instant: CskhInboxMessage[] = [];
    for (const msg of prioritized) {
      if (this.looksLikeVietnamese(msg.text) && !this.looksLikeForeignScript(msg.text)) {
        try {
          const patched = await this.prisma.cskhInboxMessage.update({
            where: { id: msg.id },
            data: { sourceLang: 'vi', translatedText: msg.text },
          });
          instant.push(patched);
          translated += 1;
        } catch {
          /* ignore */
        }
      } else {
        needAi.push(msg);
      }
    }
    if (instant.length) {
      this.publishMessageRealtime(conv.pageId, conv.id, instant, false, tenantId, conv);
    }
    if (!needAi.length) return translated;

    const chunkSize = 12;
    for (let i = 0; i < needAi.length; i += chunkSize) {
      const chunk = needAi.slice(i, i + chunkSize);
      try {
        const results = await this.ai.translateBatch({
          items: chunk.map((m) => ({
            id: m.id,
            text: m.text,
            direction: m.direction === 'outbound' ? 'outbound' : 'inbound',
          })),
          targetLang: 'vi',
          contextMessages,
        });
        const updated: CskhInboxMessage[] = [];
        for (const tr of results) {
          const src = chunk.find((c) => c.id === tr.id);
          if (!src) continue;
          const same =
            tr.sameLanguage ||
            !tr.translatedText.trim() ||
            tr.translatedText.trim() === src.text.trim();
          try {
            const patched = await this.prisma.cskhInboxMessage.update({
              where: { id: tr.id },
              data: {
                sourceLang: same
                  ? tr.detectedLang === 'und'
                    ? 'vi'
                    : tr.detectedLang
                  : tr.detectedLang,
                translatedText: same ? src.text : tr.translatedText,
              },
            });
            updated.push(patched);
            translated += 1;
          } catch (e) {
            this.logger.debug(`batch persist skip ${tr.id}: ${(e as Error).message}`);
          }
        }
        if (updated.length) {
          this.publishMessageRealtime(conv.pageId, conv.id, updated, false, tenantId, conv);
        }
      } catch (e) {
        this.logger.warn(`translate batch chunk failed: ${(e as Error).message}`);
      }
    }
    return translated;
  }

  /** Heuristic nhanh: có dấu Việt / chữ đ. */
  private looksLikeVietnamese(text: string): boolean {
    return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(
      text,
    );
  }

  /** Có script Thái / Trung / Nhật / Hàn… */
  private looksLikeForeignScript(text: string): boolean {
    return /[\u0E00-\u0E7F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(text);
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
  async markAsRead(conversationId: string, tenantId?: string, viewerUserId?: bigint | number) {
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

  async markAsUnread(conversationId: string, tenantId?: string) {
    const conv = await findInboxConversationById(this.prisma, conversationId, tenantId);
    if (!conv) throw new NotFoundException('Hội thoại không tồn tại hoặc không có quyền');

    const updatedConv = await this.prisma.cskhInboxConversation.update({
      where: { id: conversationId },
      data: { unreadCount: 1 },
    });

    const lastInbound = await this.prisma.cskhInboxMessage.findFirst({
      where: {
        conversationId,
        direction: 'inbound',
      },
      orderBy: { sentAt: 'desc' },
    });
    if (lastInbound) {
      await this.prisma.cskhInboxMessage.update({
        where: { id: lastInbound.id },
        data: { status: 'delivered' },
      });
    }

    this.realtime.publish({
      type: 'conversation',
      pageId: conv.pageId,
      conversationId,
      conversation: this.formatConversationRow(updatedConv),
      tenantId: conv.tenantId || undefined,
    });

    return { markedAsUnread: 1 };
  }

  /**
   * Đồng bộ inbox từ Graph API (khi chưa có webhook hoặc refresh).
   * options.full = true → quét ĐẦY ĐỦ: lấy hết hội thoại và hết tin nhắn mỗi hội thoại
   * (dùng để backfill dữ liệu cũ cho page mới kết nối). Nếu không, dùng giới hạn nhẹ.
   */
  async syncFromGraph(
    pageId?: string,
    tenantId?: string,
    options?: { full?: boolean; lightweight?: boolean; force?: boolean; liveHead?: boolean },
  ) {
    const redisOff = !this.redisQueue.isRedisQueueEnabled();
    const force =
      options?.force === true ||
      Boolean(pageId?.trim()) ||
      options?.lightweight === true ||
      options?.liveHead === true;
    if (!force && !redisOff && (await this.redisQueue.getWebhookQueueDepth()) > 0) {
      this.logger.log('[syncFromGraph] Bỏ qua — webhook đang có event');
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
    options?: { full?: boolean; lightweight?: boolean; force?: boolean; liveHead?: boolean },
  ) {
    const full = options?.full === true;
    const lightweight = options?.lightweight === true || options?.liveHead === true;
    const liveHead = options?.liveHead === true;
    const force = options?.force === true || Boolean(pageId?.trim()) || lightweight;
    const redisOff = !this.redisQueue.isRedisQueueEnabled();
    const where: any = {};
    if (pageId) where.pageId = pageId;
    if (tenantId) where.tenantId = tenantId;
    const pages = await this.prisma.facebookCskhConfig.findMany({ where });

    let synced = 0;
    let okPages = 0;
    const failedPages: Array<{ page: string; error: string }> = [];
    for (const page of pages) {
      if (!force && !redisOff && (await this.redisQueue.getWebhookQueueDepth()) > 0) {
        this.logger.log('[syncFromGraph] Dừng giữa chừng — nhường webhook');
        break;
      }
      await this.redisQueue.markInboxSyncActive();
      // Cô lập lỗi theo từng page: 1 page lỗi (rate limit, token hỏng, Graph 500…)
      // KHÔNG được làm dừng việc quét các page còn lại.
      try {
        synced += await this.syncSinglePageFromGraph(page, full, lightweight, {
          liveHead,
        });
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
    if (await this.redisQueue.shouldDeferInboxSync()) return;

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
      scanDate: null,
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
    options?: { force?: boolean; date?: string },
  ) {
    const runningJob = await this.findRunningBackfillJob(tenantId);
    if (runningJob) {
      return this.backfillStatusFromJob(runningJob, { running: true, paused: false });
    }
    if (this.backfillState.running) return this.toBackfillResponse();

    this.backfillTenantId = tenantId;
    this.backfillPauseRequested = false;
    this.backfillCancelRequested = false;

    const dateRaw = options?.date?.trim() ?? '';
    const requestedScanDate = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null;

    let completedPageIds: string[] = [];
    let resumeFromJob = false;
    let initialDone = 0;
    let initialAdded = 0;
    let initialOk = 0;
    let initialErrors: Array<{ page: string; error: string; pageId?: string }> = [];
    let totalAllPages = 0;
    let scanDate: string | null = requestedScanDate;

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
      scanDate = parsed.scanDate ?? requestedScanDate;
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
            scanDate,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      this.backfillJobId = job.id;
    }

    this.backfillState.scanDate = scanDate;

    const jobId = this.backfillJobId!;
    const queued = await this.redisQueue.enqueueBackfillJob({ jobId });
    if (!queued) {
      this.logger.warn(
        `[backfill] Redis queue unavailable — chạy inline (job ${jobId.slice(0, 8)})`,
      );
      void this.executeBackfillJob(jobId).catch((e) => {
        this.logger.error(`[backfill] inline job lỗi: ${(e as Error).message}`);
      });
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
      scanDate,
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
    const redisOff = !this.redisQueue.isRedisQueueEnabled();
    if (!isCskhWorkerProcess() && mode !== 'all' && !redisOff) {
      this.logger.error(
        `[backfill] executeBackfillJob bị từ chối trên process CSKH_RUN_MODE=${mode} — chỉ chạy trên worker`,
      );
      return;
    }
    if (!isCskhWorkerProcess() && mode !== 'all' && redisOff) {
      this.logger.warn(
        `[backfill] Chạy inline trên API (redis-off, job ${jobId.slice(0, 8)})`,
      );
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
      scanDate: parsed.scanDate,
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
    const scanDate = this.backfillState.scanDate;
    this.logger.log(
      `[backfill] bắt đầu quét ${pages.length} kênh còn lại — tuần tự từng kênh` +
        (scanDate ? ` (chỉ ngày ${scanDate})` : ' (toàn bộ lịch sử)') +
        ` — xong hết mới sang kênh tiếp (scope=${this.backfillState.scope}, đã xong ${this.backfillCompletedPageIds.length})`,
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
        `[backfill] (${this.backfillState.done + 1}/${this.backfillState.total}) bắt đầu kênh: ${row.pageName || row.pageId}` +
          (scanDate ? ` · ngày ${scanDate}` : ''),
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
              scanDate: scanDate ?? undefined,
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
              .syncPageAdSpendAfterBackfillPage(
                row.pageId,
                this.backfillTenantId,
                scanDate ? [scanDate] : undefined,
              )
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
        `+${this.backfillState.addedMessages} tin, ${this.backfillState.errorPages.length} page lỗi` +
        (scanDate ? ` (ngày ${scanDate})` : ''),
    );
    void this.syncPageAdSpendAfterBackfill();
  }

  /** Sau quét đầy đủ — mỗi kênh đã sync QC riêng; bỏ qua quét toàn bộ để tránh rate limit Meta. */
  private async syncPageAdSpendAfterBackfill(): Promise<void> {
    this.logger.log(
      '[backfill] Bỏ qua sync QC toàn bộ — đã đồng bộ từng kênh trong quá trình quét',
    );
  }

  /** Quét 1 page từ Graph. Tách riêng để cô lập lỗi từng page trong syncFromGraph. */
  private async syncSinglePageFromGraph(
    page: FacebookCskhConfig,
    full: boolean,
    lightweight = false,
    options?: {
      backfillMode?: boolean;
      shouldStop?: () => boolean;
      scanDate?: string;
      liveHead?: boolean;
    },
  ): Promise<number> {
    const graphPlatform = cskhInboxGraphPlatform(page.metadata);
    let synced = 0;
    const backfillMode = options?.backfillMode === true;
    const liveHead = options?.liveHead === true;
    const monitorMode = !full && lightweight && !backfillMode;
    const scanDate =
      options?.scanDate && /^\d{4}-\d{2}-\d{2}$/.test(options.scanDate)
        ? options.scanDate
        : undefined;
    const dateScopedBackfill = backfillMode && Boolean(scanDate);

    const processConv = async (fbConv: FbConversation): Promise<number> => {
      const run = async (): Promise<number> => {
      if (options?.shouldStop?.()) return 0;
      if (backfillMode && (await this.isBackfillCancelledNow())) return 0;
      if (backfillMode && (await this.isBackfillPauseRequestedNow())) return 0;
      if (!backfillMode && !monitorMode && (await this.redisQueue.shouldDeferInboxSync())) return 0;
      if (!backfillMode && !monitorMode && this.redisQueue.isRedisQueueEnabled()) {
        if ((await this.redisQueue.getWebhookQueueDepth()) > 2) return 0;
      }
      try {
        const participants = fbConv.participants?.data ?? [];
        const customer = participants.find((p) => String(p.id) !== String(page.pageId));
        if (!customer?.id) return 0;

        const rawMsgs = dateScopedBackfill
          ? this.graph.filterMessagesByDay(fbConv.messages?.data ?? [], scanDate!)
          : backfillMode
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
        if (dateScopedBackfill && rawMsgs.length === 0) return 0;
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
            { platform: graphPlatform },
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

        if (monitorMode && oldConv?.lastMessageAt && fbConv.updated_time) {
          const graphAt = new Date(fbConv.updated_time).getTime();
          const dbAt = oldConv.lastMessageAt.getTime();
          if (graphAt > 0 && Math.abs(graphAt - dbAt) < 1500) return 0;
        }

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
          inboxListPreview({
            text: newestNorm?.text ?? rawMsgs[0]?.message,
            messageType: newestNorm?.messageType,
            attachmentCount: newestNorm?.attachmentUrls?.length ?? (newestNorm?.attachmentUrl ? 1 : 0),
          }) || newestNorm?.text || rawMsgs[0]?.message?.trim() || null;

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
          if (!backfillMode && added > 0) {
            const latest = await this.prisma.cskhInboxMessage.findFirst({
              where: { conversationId: conv.id },
              orderBy: { sentAt: 'desc' },
            });
            const liveCutoff = new Date(Date.now() - 180_000);
            const liveRows = await this.prisma.cskhInboxMessage.findMany({
              where: { conversationId: conv.id, sentAt: { gte: liveCutoff } },
              orderBy: { sentAt: 'asc' },
              take: 20,
            });
            const bumped =
              latest && latest.sentAt.getTime() >= liveCutoff.getTime()
                ? await this.prisma.cskhInboxConversation.update({
                    where: { id: conv.id },
                    data: {
                      lastMessageAt: latest.sentAt,
                      lastMessage: latest.text || conv.lastMessage,
                    },
                  })
                : conv;
            if (liveRows.length) {
              this.realtime.publish({
                type: 'message',
                pageId: bumped.pageId,
                conversationId: bumped.id,
                messages: liveRows.map((m) => this.formatMessageRow(m)),
                conversation: this.formatConversationRow(bumped),
                tenantId: bumped.tenantId || undefined,
              });
            } else if (latest && latest.sentAt.getTime() >= liveCutoff.getTime()) {
              this.realtime.publish({
                type: 'conversation',
                conversationId: bumped.id,
                pageId: bumped.pageId,
                conversation: this.formatConversationRow(bumped),
                tenantId: bumped.tenantId || undefined,
              });
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
      if (!backfillMode && !monitorMode && (await this.redisQueue.shouldDeferInboxSync())) return 'stop';
      for (const fbConv of batch) {
        if (options?.shouldStop?.()) return 'stop';
        if (backfillMode && (await this.isBackfillCancelledNow())) return 'stop';
        if (backfillMode && (await this.isBackfillPauseRequestedNow())) return 'stop';
        synced += await processConv(fbConv);
      }
      return 'continue';
    };

    if (backfillMode && full && dateScopedBackfill && scanDate) {
      const convs = await this.graph.fetchConversationsForAuditByDate(
        page.pageId,
        page.pageAccessToken,
        scanDate,
        scanDate,
        this.msgLimit,
        async (_scanned, matched) => {
          this.backfillState.pageConvsDone = matched;
          await this.persistBackfillJob('running', this.backfillCompletedPageIds);
        },
        6,
        () =>
          Boolean(
            options?.shouldStop?.() ||
              this.backfillPauseRequested ||
              this.backfillCancelRequested,
          ),
        undefined,
        0,
        undefined,
        graphPlatform,
      );
      for (const fbConv of convs) {
        if (options?.shouldStop?.()) break;
        if (await this.isBackfillCancelledNow()) break;
        if (await this.isBackfillPauseRequestedNow()) break;
        const dayMsgs = this.graph.filterMessagesByDay(
          fbConv.messages?.data ?? [],
          scanDate,
        );
        synced += await processConv({
          ...fbConv,
          messages: { data: dayMsgs },
        });
      }
      this.logger.log(
        `[backfill] ${page.pageName || page.pageId}: ngày ${scanDate} — ${convs.length} hội thoại, +${synced} tin`,
      );
      return synced;
    }

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
        graphPlatform,
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
          graphPlatform,
        )
      : await this.graph.fetchConversationsForMonitor(
          page.pageId,
          page.pageAccessToken,
          liveHead ? this.catchUpConvLimit : this.syncLimit,
          graphPlatform,
        );
    if (!liveHead) {
      this.logger.log(
        `[syncFromGraph${full ? ':full' : ''}] ${page.pageName || page.pageId}: ${convs.length} hội thoại`,
      );
    }

    for (const fbConv of convs) {
      if (options?.shouldStop?.()) break;
      if (backfillMode && (await this.isBackfillPauseRequestedNow())) break;
      if (!backfillMode && !monitorMode && (await this.redisQueue.shouldDeferInboxSync())) {
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

    const page = await this.prisma.facebookCskhConfig.findFirst({
      where: tenantId ? { pageId, tenantId } : { pageId },
    });
    const pageName = page?.pageName ?? null;
    const graphPlatform = cskhInboxGraphPlatform(page?.metadata);
    const profile = pageAccessToken
      ? await this.graph.getMessengerUserProfile(participantPsid, pageAccessToken, {
          platform: graphPlatform,
        })
      : { name: null, pictureUrl: null };
    const customerPictureUrl = profile.pictureUrl;
    const finalCustomerName = profile.name ?? customerName;

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
    const profile = await this.graph.getMessengerUserProfile(participantPsid, page.pageAccessToken, {
      platform: cskhInboxGraphPlatform(page.metadata),
    });
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
