import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
  OnModuleInit,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { Response } from 'express';
import { PrismaService, Prisma } from '../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { FacebookGraphService, type FbConversation, type FbMessage } from './facebook/facebook-graph.service';
import { FacebookAdsService, type AdInsightsPayload } from './facebook/facebook-ads.service';
import { GraphApiCoordinatorService } from './facebook/graph-api-coordinator.service';
import { RedisQueueService } from './redis/redis-queue.service';
import { getCskhRunMode, isCskhApiProcess, shouldAuditYieldToInbox } from './cskh-run-mode';
import { CskhInboxService } from './inbox/cskh-inbox.service';
import {
  buildFacebookOAuthUrl,
  getFacebookAppId,
  getFacebookAppSecret,
  getFacebookOAuthRedirectUri,
  verifyOAuthState,
  GRAPH_BASE,
} from './facebook/facebook-oauth.util';
import { isAllowedFacebookMediaUrl } from './facebook/facebook-message.util';
import { findInboxConversationById } from './inbox/cskh-inbox-conversation.util';
import { detectAdFromFbMessages, parseWebhookReferral } from './facebook/facebook-referral.util';
import { trimTranscriptForAi, type TranscriptLine } from './audit/audit-analytics.util';
import { toUserFacingError } from '../common/user-facing-error.util';

/** Page CSKH đang bật — trường dùng trong monitor/audit (tránh phụ thuộc export Prisma model). */
type EnabledFacebookPage = {
  pageId: string;
  pageName: string | null;
  pageAccessToken: string;
};

@Injectable()
export class CskhService implements OnModuleInit {
  private readonly logger = new Logger(CskhService.name);
  private readonly delayBetweenMs = Number(process.env.CSKH_DELAY_BETWEEN_MS || 800);
  /** Monitor: số hội thoại gần nhất cần quét / Page. */
  private readonly monitorMax = Number(process.env.CSKH_MONITOR_MAX_CONVERSATIONS || 10);
  private readonly auditMax = Number(process.env.CSKH_AUDIT_MAX_CONVERSATIONS || 0);
  /** Cron ban đêm: số cuộc hội thoại gần nhất / kênh. */
  private readonly auditCronMax = Number(process.env.CSKH_AUDIT_CRON_MAX || 30);
  /** Số ngày lùi khi quét (manual + cron) — lấy hội thoại mới nhất trong khoảng này. */
  private readonly auditDefaultLookbackDays = Number(
    process.env.CSKH_AUDIT_LOOKBACK_DAYS || 30,
  );
  /** Số hội thoại chấm AI song song — worker process có thể cao hơn API. */
  private readonly auditConcurrency = Number(
    process.env.CSKH_AUDIT_CONCURRENCY ||
      (getCskhRunMode() === 'worker' ? 1 : 1),
  );
  /** Số hội thoại fetch tin FB song song / batch. */
  private readonly auditFetchConcurrency = Number(
    process.env.CSKH_AUDIT_FETCH_CONCURRENCY ||
      (getCskhRunMode() === 'worker' ? 2 : 6),
  );
  /** Số Page quét FB song song (khi bật nhiều page). */
  private readonly auditPageConcurrency = Number(
    process.env.CSKH_AUDIT_PAGE_CONCURRENCY ||
      (getCskhRunMode() === 'worker' ? 1 : 2),
  );
  private readonly auditMsgLimit = Number(process.env.CSKH_AUDIT_MSG_LIMIT || 100);
  private readonly auditSource = process.env.CSKH_AUDIT_SOURCE || 'facebook';
  /** Tối đa dòng transcript gửi AI (DB vẫn lưu đủ). */
  private readonly auditAiTranscriptMax = Number(process.env.CSKH_AUDIT_AI_TRANSCRIPT_MAX || 100);
  private readonly auditProgressEvery = Math.max(
    1,
    Number(process.env.CSKH_AUDIT_PROGRESS_EVERY || 40),
  );
  private readonly monitorMaxPages = Number(process.env.CSKH_MONITOR_MAX_PAGES || 10);
  private readonly monitorPageConcurrency = Number(process.env.CSKH_MONITOR_PAGE_CONCURRENCY || 3);
  /** Số hội thoại fetch messages song song / Page (tăng tốc monitor). */
  private readonly monitorMsgConcurrency = Number(process.env.CSKH_MONITOR_MSG_CONCURRENCY || 8);

  private readonly activeJobs = new Map<string, { pauseRequested: boolean }>();
  private readonly dashboardStatsCache = new Map<
    string,
    {
      at: number;
      data: Awaited<ReturnType<CskhService['getDashboardStats']>>;
    }
  >();
  private readonly dashboardHeavyCountsCache = new Map<
    string,
    {
      at: number;
      data: Awaited<ReturnType<CskhService['getDashboardHeavyStats']>>;
    }
  >();
  private readonly dashboardStatsTtlMs = Number(process.env.CSKH_DASHBOARD_STATS_TTL_MS || 120_000);
  private readonly dashboardHeavyCountsTtlMs = Number(
    process.env.CSKH_DASHBOARD_HEAVY_TTL_MS || 600_000,
  );
  private readonly adInsightsConvCache = new Map<
    string,
    { at: number; data: AdInsightsPayload }
  >();
  private readonly pageListLiteCache = new Map<
    string,
    { at: number; data: Awaited<ReturnType<CskhService['listPages']>> }
  >();
  private readonly pageListLiteCacheTtlMs = Number(process.env.CSKH_PAGE_LIST_LITE_CACHE_MS || 120_000);
  /** Tổng tin nhắn theo page — đổi chậm, cache để đổi ngày filter không quét lại 300k+ tin. */
  private readonly pageTotalMsgStatsCache = new Map<
    string,
    {
      at: number;
      data?: Map<string, number>;
      bundle?: {
        convMap: Map<string, number>;
        unreadMap: Map<string, number>;
        messageMap: Map<string, number>;
      };
    }
  >();
  private readonly pageTotalMsgStatsCacheTtlMs = Number(
    process.env.CSKH_PAGE_TOTAL_MSG_CACHE_MS || 300_000,
  );
  /** Thống kê inbound theo ngày — cache ngắn khi user đổi ngày liên tục. */
  private readonly pageInboundDayCache = new Map<
    string,
    { at: number; data: Map<string, number> }
  >();
  private readonly pageInboundDayCacheTtlMs = Number(
    process.env.CSKH_PAGE_INBOUND_DAY_CACHE_MS || 45_000,
  );
  private readonly pageAdSpendSyncScheduled = new Map<string, number>();
  /** null = chưa kiểm tra; false = bảng chưa migrate → bỏ qua mọi sync QC. */
  private pageAdSpendSchemaAvailable: boolean | null = null;

  private readonly adInsightsConvCacheTtlMs = Number(
    process.env.CSKH_AD_INSIGHTS_CONV_CACHE_MS || 900_000,
  );
  /** null = chưa kiểm tra; false = bảng chưa migrate → fallback COUNT chậm. */
  private pageMessageTotalsTableAvailable: boolean | null = null;

  private readonly oauthSyncInFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    private readonly graph: FacebookGraphService,
    private readonly ads: FacebookAdsService,
    private readonly graphCoordinator: GraphApiCoordinatorService,
    @Inject(forwardRef(() => RedisQueueService))
    private readonly redisQueue: RedisQueueService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => CskhInboxService))
    private readonly inboxService: CskhInboxService,
  ) {}

  /** BE restart — hủy job kẹt + xóa hàng đợi audit (chạy trước audit worker). */
  async onModuleInit() {
    await this.cleanupStuckJobsOnBoot();
  }

  /** Hủy job audit/monitor đang running + purge Redis queue — tránh quét lại khi restart. */
  async cleanupStuckJobsOnBoot(): Promise<{ cancelledJobs: number; purgedQueue: number }> {
    const mode = getCskhRunMode();
    const n = await this.prisma.cskhJobRun.updateMany({
      where: { status: 'running' },
      data: {
        status: 'failed',
        error: 'Server khởi động lại — vui lòng chạy job mới',
        finishedAt: new Date(),
      },
    });
    const purgedAudit = await this.redisQueue.purgeAuditQueue();
    const purgedBackfill = await this.redisQueue.purgeBackfillQueue();
    const purged = purgedAudit + purgedBackfill;
    if (n.count > 0 || purged > 0) {
      this.logger.warn(
        `Restart (${mode}): hủy ${n.count} job running, xóa ${purgedAudit} audit + ${purgedBackfill} backfill queue item(s)`,
      );
    }

    if (isCskhApiProcess()) {
      if (process.env.CSKH_RESUBSCRIBE_ON_BOOT === 'true') {
        void this.resubscribeAllPagesWebhook().catch((e) => {
          this.logger.warn(`Resubscribe webhook on boot failed: ${(e as Error).message}`);
        });
      }
    }

    return { cancelledJobs: n.count, purgedQueue: purged };
  }

  /** Đăng ký lại webhook (subscribed_apps) cho tất cả page đã kết nối. Idempotent. */
  async resubscribeAllPagesWebhook() {
    const pages = await this.prisma.facebookCskhConfig.findMany({
      where: { pageAccessToken: { not: '' } },
      select: { pageId: true, pageName: true, pageAccessToken: true },
    });
    let ok = 0;
    for (const p of pages) {
      if (!p.pageAccessToken) continue;
      try {
        await this.subscribePageToWebhook(p.pageId, p.pageAccessToken);
        ok++;
      } catch (e) {
        this.logger.warn(`Resubscribe ${p.pageName || p.pageId} lỗi: ${(e as Error).message}`);
      }
      // Tránh burst request làm nghẽn DB/API khi server vừa khởi động.
      await new Promise((r) => setTimeout(r, 150));
    }
    this.logger.log(`Resubscribe webhook xong: ${ok}/${pages.length} page (đã bật message_echoes).`);
    return { total: pages.length, ok };
  }

  async cancelRunningJobs(type: 'monitor' | 'audit', reason = 'Đã hủy bởi người dùng', tenantId?: string) {
    const where: any = { type, status: 'running' };
    if (tenantId) where.tenantId = tenantId;
    const running = await this.prisma.cskhJobRun.findMany({
      where,
      select: { id: true },
    });
    for (const j of running) {
      this.activeJobs.delete(j.id);
      if (type === 'audit') {
        await this.redisQueue.setAuditPauseRequested(j.id);
        await this.redisQueue.purgeAuditQueueForJobIds([j.id]);
        // Delete all chat audits generated by this cancelled job run to keep DB clean
        try {
          await this.prisma.$executeRaw`
            DELETE FROM chat_audits
            WHERE metadata->>'jobRunId' = ${j.id}
          `;
          this.logger.log(`Deleted partial chat audits for cancelled job ${j.id}`);
        } catch (err) {
          this.logger.error(`Failed to delete partial audits for job ${j.id}: ${(err as Error).message}`);
        }
      }
    }
    const result = await this.prisma.cskhJobRun.updateMany({
      where,
      data: { status: 'failed', error: reason, finishedAt: new Date() },
    });
    return result.count;
  }

  /** Tạm dừng audit — lưu phần đã chấm, worker dừng quét/chấm mới ngay. */
  async requestAuditPause(tenantId?: string) {
    const job = await this.findRunningJob('audit', tenantId);
    if (!job) {
      return { paused: false, message: 'Không có job audit đang chạy' };
    }
    const active = this.activeJobs.get(job.id);
    if (active) {
      active.pauseRequested = true;
    } else {
      this.activeJobs.set(job.id, { pauseRequested: true });
    }
    await this.redisQueue.setAuditPauseRequested(job.id);
    await this.updateJobProgress(job.id, { pauseRequested: true, phase: 'pausing' });
    this.logger.log(`Audit pause requested job=${job.id.slice(0, 8)}`);
    return { paused: true, jobId: job.id };
  }

  /** Job đã bị hủy hoặc kết thúc (status không còn running). */
  private async isAuditJobCancelled(jobId: string): Promise<boolean> {
    const job = await this.prisma.cskhJobRun.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    if (!job || job.status !== 'running') {
      this.activeJobs.delete(jobId);
      await this.redisQueue.clearAuditPauseRequested(jobId);
      return true;
    }
    return false;
  }

  /** Dừng quét / chấm: tạm dừng, hủy, hoặc nhường inbox realtime. */
  private async shouldStopAuditJob(jobId: string): Promise<boolean> {
    const mem = this.activeJobs.get(jobId);
    if (mem?.pauseRequested) return true;
    if (await this.redisQueue.isAuditPauseRequested(jobId)) {
      if (mem) mem.pauseRequested = true;
      else this.activeJobs.set(jobId, { pauseRequested: true });
      return true;
    }
    const job = await this.prisma.cskhJobRun.findUnique({
      where: { id: jobId },
      select: { status: true, summary: true },
    });
    if (!job || job.status !== 'running') {
      if (mem) this.activeJobs.delete(jobId);
      return true;
    }
    const summary = job.summary as Record<string, unknown> | null;
    const pauseRequested = Boolean(summary?.pauseRequested);
    if (pauseRequested) {
      if (mem) mem.pauseRequested = true;
      await this.redisQueue.setAuditPauseRequested(jobId);
      return true;
    }
    return false;
  }

  /** Audit fetch Graph tạm dừng khi pause; chỉ API dev/all mới nhường inbox hot. */
  private async shouldAbortAuditFetch(jobId: string): Promise<boolean> {
    if (await this.shouldStopAuditJob(jobId)) return true;
    if (!shouldAuditYieldToInbox()) return false;
    return this.redisQueue.shouldYieldGraphToInbox();
  }

  private async loadAuditedConversationKeys(
    auditDateFrom: string,
    auditDateTo: string,
    pageIds: string[],
  ): Promise<Set<string>> {
    if (!pageIds.length) return new Set();

    type Row = {
      conversationId: string | null;
      pageId: string | null;
      participantPsid: string | null;
    };

    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT
        metadata->>'conversationId' AS "conversationId",
        metadata->>'pageId' AS "pageId",
        metadata->>'participantPsid' AS "participantPsid"
      FROM chat_audits
      WHERE metadata->>'pageId' = ANY(${pageIds}::text[])
        AND (
          (
            metadata->>'auditDateFrom' = ${auditDateFrom}
            AND metadata->>'auditDateTo' = ${auditDateTo}
          )
          OR (
            ${auditDateFrom} = ${auditDateTo}
            AND metadata->>'auditDate' = ${auditDateFrom}
            AND COALESCE(metadata->>'auditDateFrom', '') = ''
          )
        )
    `;

    const keys = new Set<string>();
    for (const row of rows) {
      const pageId = row.pageId?.trim();
      if (!pageId) continue;
      const convId = row.conversationId?.trim();
      const psid = row.participantPsid?.trim();
      if (convId) keys.add(`${pageId}:conv:${convId}`);
      if (psid) keys.add(`${pageId}:psid:${psid}`);
    }
    return keys;
  }

  private isConversationAlreadyAudited(
    keys: Set<string>,
    pageId: string,
    conv: FbConversation,
  ): boolean {
    if (keys.has(`${pageId}:conv:${conv.id}`)) return true;
    const psid = this.graph.resolveParticipantPsid(conv.participants, pageId);
    return Boolean(psid && keys.has(`${pageId}:psid:${psid}`));
  }

  /** Một query / danh sách page — tránh N lần findUnique khi chấm hàng nghìn hội thoại. */
  private async loadInboxAdMaps(pageIds: string[]) {
    type InboxAdRow = {
      fromAd: boolean;
      adId: string | null;
      adTitle: string | null;
      referralSource: string | null;
    };
    const byPage = new Map<string, Map<string, InboxAdRow>>();
    if (!pageIds.length) return byPage;

    const rows = await this.prisma.cskhInboxConversation.findMany({
      where: { pageId: { in: pageIds } },
      select: {
        pageId: true,
        participantPsid: true,
        fromAd: true,
        adId: true,
        adTitle: true,
        referralSource: true,
      },
    });
    for (const row of rows) {
      const psid = row.participantPsid?.trim();
      if (!psid) continue;
      let map = byPage.get(row.pageId);
      if (!map) {
        map = new Map();
        byPage.set(row.pageId, map);
      }
      map.set(psid, {
        fromAd: row.fromAd,
        adId: row.adId,
        adTitle: row.adTitle,
        referralSource: row.referralSource,
      });
    }
    return byPage;
  }

  /** Job running nhưng không có tiến trình → coi là treo. */
  private async failGhostJobIfNeeded(
    job: { id: string; status: string; startedAt: Date; summary: unknown },
    auditCount: number,
  ) {
    if (job.status !== 'running') return false;
    const ageMs = Date.now() - job.startedAt.getTime();
    const summary = (job.summary as Record<string, unknown> | null) ?? {};
    const phase = String(summary.phase ?? '');
    const total = Number(summary.total ?? 0);
    const processed = Number(summary.processed ?? 0);
    const fetched = Number(summary.fetched ?? 0);
    const scanned = Number(summary.scanned ?? 0);
    const pagesProcessed = Number(summary.pagesProcessed ?? 0);
    const currentPage = String(summary.currentPage ?? '');

    // Giai đoạn quét (Graph/DB) có thể lâu trước khi fetched tăng — không hủy sớm.
    if (phase === 'fetch') {
      if (scanned > 0 || pagesProcessed > 0 || currentPage) return false;
      if (ageMs < 15 * 60_000) return false;
    }

    // Job audit đang gọi AI — không hủy sớm (AI ~5–8s/conv, DB lưu chậm hơn poll UI).
    if (phase === 'audit' && total > 0) {
      if (ageMs > 60 * 60_000 && processed === 0 && auditCount === 0) {
        await this.prisma.cskhJobRun.update({
          where: { id: job.id },
          data: {
            status: 'failed',
            error: 'Job quá hạn — AI không phản hồi',
            finishedAt: new Date(),
          },
        });
        this.logger.warn(`Hủy audit job ${job.id.slice(0, 8)} — AI timeout (${Math.round(ageMs / 1000)}s)`);
        return true;
      }
      return false;
    }

    if (ageMs < 120_000) return false;

    const noProgress = auditCount === 0 && fetched === 0 && processed === 0;
    if (!noProgress) return false;

    await this.prisma.cskhJobRun.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        error: 'Job treo — không có tiến trình (thử Chạy lại)',
        finishedAt: new Date(),
      },
    });
    this.logger.warn(`Hủy ghost job ${job.id.slice(0, 8)} (phase=${phase}, age ${Math.round(ageMs / 1000)}s)`);
    return true;
  }

  private frontendUrl(): string {
    return this.config.get<string>('FRONTEND_URL', 'http://localhost:5173').replace(/\/$/, '');
  }

  defaultOAuthReturnUrl(): string {
    return `${this.frontendUrl()}/settings?tab=channel`;
  }

  getOAuthStartUrl(returnUrl?: string, tenantId?: string) {
    if (!getFacebookAppId() || !getFacebookAppSecret()) {
      throw new ServiceUnavailableException(
        'Chưa cấu hình FB_APP_ID và FB_APP_SECRET trên BE',
      );
    }
    return buildFacebookOAuthUrl(returnUrl?.trim() || this.defaultOAuthReturnUrl(), tenantId);
  }

  async listPages(tenantId?: string, options?: { month?: string; date?: string; lite?: boolean }) {
    type PageListRow = {
      pageId: string;
      pageName: string | null;
      enabled: boolean;
      updatedAt: Date;
      metadata: Prisma.JsonValue | null;
    };
    const pageListSelect = {
      pageId: true,
      pageName: true,
      enabled: true,
      updatedAt: true,
      metadata: true,
    } as const;

    const month = options?.month?.trim();
    const date = options?.date?.trim();
    const inboundDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
    const inboundMonth =
      !inboundDate && month && /^\d{4}-\d{2}$/.test(month) ? month : undefined;

    const rows = await this.prisma.facebookCskhConfig.findMany({
      where: tenantId ? { tenantId } : undefined,
      orderBy: [{ enabled: 'desc' }, { pageName: 'asc' }],
      select: pageListSelect,
    });

    const useLite = Boolean(options?.lite) && !inboundMonth && !inboundDate;

    if (useLite) {
      const cacheKey = tenantId ?? '__all__';
      const cached = this.pageListLiteCache.get(cacheKey);
      if (cached && Date.now() - cached.at < this.pageListLiteCacheTtlMs) {
        return cached.data;
      }
      const liteResult = await this.buildLitePageListResponse(tenantId, rows);
      this.pageListLiteCache.set(cacheKey, { at: Date.now(), data: liteResult });
      return liteResult;
    }

    const pageIds = rows.map((r) => r.pageId);

    const oauthPromise = this.prisma.facebookOAuthSession.findFirst({
      where: tenantId ? { tenantId } : undefined,
      orderBy: { updatedAt: 'desc' },
      select: { fbUserId: true, fbUserName: true, tokenExpiresAt: true, updatedAt: true, metadata: true },
    });

    const [pageStats, inboundStatsMap, oauth] = await Promise.all([
      pageIds.length
        ? this.loadPageStatsBundleCached(tenantId, pageIds, {
            allowStaleDuringBackfill: true,
          })
        : Promise.resolve({
            convMap: new Map<string, number>(),
            unreadMap: new Map<string, number>(),
            messageMap: new Map<string, number>(),
          }),
      inboundMonth && pageIds.length
        ? this.loadPageInboundMessageStats(inboundMonth, pageIds)
        : inboundDate && pageIds.length
          ? this.loadPageInboundMessageStatsForRangeCached(
              tenantId,
              inboundDate,
              inboundDate,
              pageIds,
            )
          : Promise.resolve(new Map<string, number>()),
      oauthPromise,
    ]);

    const convCountMap = pageStats.convMap;
    const unreadCountMap = pageStats.unreadMap;
    const totalMessageStatsMap = pageStats.messageMap;

    const missingPictureIds = rows
      .filter((r) => !this.pagePictureUrl(r.metadata))
      .map((r) => r.pageId);
    if (missingPictureIds.length) {
      void this.enrichPagePictures(missingPictureIds).catch((e) =>
        this.logger.warn(`enrichPagePictures: ${(e as Error).message}`),
      );
    }

    const oauthMeta =
      (oauth?.metadata as {
        syncStatus?: string;
        syncError?: string | null;
        adAccounts?: unknown[];
        adAccountsCheckedAt?: string;
        pageCount?: number;
      } | null) ?? null;
    const oauthSyncStatus =
      oauthMeta?.syncStatus === 'running' ||
      oauthMeta?.syncStatus === 'failed' ||
      oauthMeta?.syncStatus === 'done'
        ? oauthMeta.syncStatus
        : null;
    const oauthSyncError = oauthMeta?.syncError ?? null;

    let adStats = { adAccountCount: 0, adsReadConnected: false };
    if (oauth) {
      const cachedCount = Array.isArray(oauthMeta?.adAccounts) ? oauthMeta.adAccounts.length : 0;
      if (inboundDate || inboundMonth) {
        adStats = { adAccountCount: cachedCount, adsReadConnected: cachedCount > 0 };
      } else if (oauthSyncStatus !== 'running') {
        adStats = await this.refreshOAuthAdAccountsIfNeeded(oauth.fbUserId);
      } else {
        adStats = { adAccountCount: cachedCount, adsReadConnected: cachedCount > 0 };
      }
    }

    const adSpendMap =
      inboundDate && pageIds.length
        ? await this.loadPageAdSpendCache(inboundDate, pageIds, tenantId)
        : new Map<string, {
            spend: number | null;
            currency: string | null;
            messagingConversations: number | null;
            costPerConversation: number | null;
            adAccountName: string | null;
            unavailableReason: string | null;
            syncedAt: Date | null;
          }>();

    let adSpendSyncPending = false;
    if (inboundDate && pageIds.length) {
      adSpendSyncPending = await this.schedulePageAdSpendSyncIfNeeded(
        inboundDate,
        tenantId,
        pageIds,
        adSpendMap,
      );
    }

  let totalAdSpend = 0;
  let adSpendCurrency: string | null = null;

    return {
      pages: rows.map((row) => {
        const ad = inboundDate ? adSpendMap.get(row.pageId) : undefined;
        const inboundCount =
          inboundMonth || inboundDate ? inboundStatsMap.get(row.pageId) || 0 : undefined;
        let adCostPerConversation = ad?.costPerConversation ?? null;
        if (
          adCostPerConversation == null &&
          ad?.spend != null &&
          ad.spend > 0 &&
          inboundCount != null &&
          inboundCount > 0
        ) {
          adCostPerConversation = ad.spend / inboundCount;
        }
        if (ad?.spend != null && ad.spend > 0) {
          totalAdSpend += ad.spend;
          if (!adSpendCurrency && ad.currency) adSpendCurrency = ad.currency;
        }
        return {
        pageId: row.pageId,
        pageName: row.pageName,
        enabled: row.enabled,
        updatedAt: row.updatedAt,
        pagePictureUrl: this.pagePictureUrl(row.metadata),
        conversationCount: convCountMap.get(row.pageId) || 0,
        messageCount: totalMessageStatsMap.get(row.pageId) || 0,
        unreadConversationCount: unreadCountMap.get(row.pageId) || 0,
        inboundMessageCount: inboundCount,
        adSpend: ad?.spend ?? null,
        adSpendCurrency: ad?.currency ?? null,
        adMessagingConversations: ad?.messagingConversations ?? null,
        adCostPerConversation,
        adAccountName: ad?.adAccountName ?? null,
        adSpendUnavailableReason: ad?.unavailableReason ?? null,
        adSpendSyncedAt: ad?.syncedAt?.toISOString() ?? null,
      };
      }),
      inboundMonth: inboundMonth
        ? {
            month: inboundMonth,
            totalInbound: Array.from(inboundStatsMap.values()).reduce((sum, n) => sum + n, 0),
          }
        : undefined,
      inboundDay: inboundDate
        ? {
            date: inboundDate,
            totalInbound: Array.from(inboundStatsMap.values()).reduce((sum, n) => sum + n, 0),
            totalAdSpend: totalAdSpend > 0 ? totalAdSpend : null,
            adSpendCurrency,
            adSpendSyncPending,
          }
        : undefined,
      statsMeta: inboundMonth
        ? { inboundMonthStats: true as const, requestedMonth: inboundMonth, buildTag: 'inbound-month-v1' }
        : inboundDate
          ? { inboundDayStats: true as const, requestedDate: inboundDate, buildTag: 'inbound-day-v1' }
          : undefined,
      oauthConnected: Boolean(oauth),
      oauthUser: oauth?.fbUserName || oauth?.fbUserId || null,
      oauthUpdatedAt: oauth?.updatedAt || null,
      oauthExpiresAt: oauth?.tokenExpiresAt || null,
      oauthSyncStatus,
      oauthSyncError,
      adsReadConnected: adStats.adsReadConnected,
      adAccountCount: adStats.adAccountCount,
    };
  }

  /** Danh sách Page nhanh cho dropdown inbox — không quét thống kê tin / OAuth Meta. */
  private async buildLitePageListResponse(
    tenantId: string | undefined,
    rows: Array<{
      pageId: string;
      pageName: string | null;
      enabled: boolean;
      updatedAt: Date;
      metadata: Prisma.JsonValue | null;
    }>,
  ) {
    const oauth = await this.prisma.facebookOAuthSession.findFirst({
      where: tenantId ? { tenantId } : undefined,
      orderBy: { updatedAt: 'desc' },
      select: { fbUserId: true, fbUserName: true, tokenExpiresAt: true, updatedAt: true, metadata: true },
    });
    const oauthMeta =
      (oauth?.metadata as {
        syncStatus?: string;
        syncError?: string | null;
        adAccounts?: unknown[];
      } | null) ?? null;
    const oauthSyncStatus =
      oauthMeta?.syncStatus === 'running' ||
      oauthMeta?.syncStatus === 'failed' ||
      oauthMeta?.syncStatus === 'done'
        ? oauthMeta.syncStatus
        : null;
    const cachedAdCount = Array.isArray(oauthMeta?.adAccounts) ? oauthMeta.adAccounts.length : 0;

    return {
      pages: rows.map((row) => ({
        pageId: row.pageId,
        pageName: row.pageName,
        enabled: row.enabled,
        updatedAt: row.updatedAt,
        pagePictureUrl: this.pagePictureUrl(row.metadata),
      })),
      oauthConnected: Boolean(oauth),
      oauthUser: oauth?.fbUserName || oauth?.fbUserId || null,
      oauthUpdatedAt: oauth?.updatedAt || null,
      oauthExpiresAt: oauth?.tokenExpiresAt || null,
      oauthSyncStatus,
      oauthSyncError: oauthMeta?.syncError ?? null,
      adsReadConnected: cachedAdCount > 0,
      adAccountCount: cachedAdCount,
    };
  }

  private invalidatePageListLiteCache(tenantId?: string) {
    if (tenantId) {
      this.pageListLiteCache.delete(tenantId);
      return;
    }
    this.pageListLiteCache.clear();
  }

  /** Xóa cache thống kê Page/Kênh — local + Redis (worker → API). */
  async bumpPageStatsCaches(tenantId?: string, options?: { inboundOnly?: boolean }) {
    if (tenantId) {
      for (const key of [...this.pageInboundDayCache.keys()]) {
        if (key.startsWith(`${tenantId}:`)) {
          this.pageInboundDayCache.delete(key);
        }
      }
    } else {
      this.pageInboundDayCache.clear();
    }
    if (!options?.inboundOnly) {
      this.pageTotalMsgStatsCache.clear();
    }
    await this.redisQueue.bumpPageStatsCache(tenantId);
  }

  /** @deprecated use bumpPageStatsCaches */
  invalidatePageStatsCaches(tenantId?: string) {
    void this.bumpPageStatsCaches(tenantId);
  }

  /** Đồng bộ chi tiêu QC 1 kênh vừa quét xong (hôm qua + hôm nay VN). */
  async syncPageAdSpendAfterBackfillPage(pageId: string, tenantId?: string) {
    if (!(await this.isPageAdSpendSchemaAvailable())) return;
    const today = this.vietnamCalendarDate(0);
    const yesterday = this.vietnamCalendarDate(-1);
    const delayMs = Number(process.env.CSKH_PAGE_AD_SYNC_DELAY_MS || 1_200);
    for (const statDate of [yesterday, today]) {
      try {
        const res = await this.syncPageAdSpendDaily(pageId, statDate, tenantId);
        if (res.ok) {
          this.logger.log(`[backfill] QC ${pageId} ${statDate}: spend synced`);
        }
      } catch (e) {
        this.logger.warn(
          `[backfill] QC ${pageId} ${statDate}: ${(e as Error).message}`,
        );
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
    await this.bumpPageStatsCaches(tenantId, { inboundOnly: true });
  }

  /** Kiểm tra bảng cskh_page_ad_spend_daily — cache kết quả. */
  async isPageAdSpendSchemaAvailable(): Promise<boolean> {
    if (this.pageAdSpendSchemaAvailable != null) return this.pageAdSpendSchemaAvailable;
    try {
      await this.prisma.cskhPageAdSpendDaily.findFirst({ select: { id: true } });
      this.pageAdSpendSchemaAvailable = true;
    } catch (e) {
      if (this.isPageAdSpendSchemaMissing(e)) {
        this.pageAdSpendSchemaAvailable = false;
        this.logger.warn(
          'cskh_page_ad_spend_daily chưa migrate — tắt đồng bộ chi phí QC (chạy prisma/manual-page-ad-spend.sql)',
        );
      } else {
        throw e;
      }
    }
    return this.pageAdSpendSchemaAvailable;
  }

  private async isInboxBackfillRunning(tenantId?: string): Promise<boolean> {
    const job = await this.prisma.cskhJobRun.findFirst({
      where: {
        type: 'inbox-backfill',
        status: 'running',
        ...(tenantId ? { tenantId } : {}),
      },
      select: { id: true },
    });
    return Boolean(job);
  }

  /** Ngày lịch VN (YYYY-MM-DD), offsetDays âm = hôm qua... */
  vietnamCalendarDate(offsetDays = 0): string {
    const ts = Date.now() + offsetDays * 86_400_000;
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(ts));
  }

  private async loadPageAdSpendCache(statDate: string, pageIds: string[], tenantId?: string) {
    if (!(await this.isPageAdSpendSchemaAvailable())) {
      return new Map();
    }
    if (!pageIds.length) return new Map<string, {
      spend: number | null;
      currency: string | null;
      messagingConversations: number | null;
      costPerConversation: number | null;
      adAccountName: string | null;
      unavailableReason: string | null;
      syncedAt: Date | null;
    }>();
    try {
      const rows = await this.prisma.cskhPageAdSpendDaily.findMany({
        where: {
          statDate,
          pageId: { in: pageIds },
          ...(tenantId ? { tenantId } : {}),
        },
      });
      return new Map(
        rows.map((r) => [
          r.pageId,
          {
            spend: r.spend,
            currency: r.currency,
            messagingConversations: r.messagingConversations,
            costPerConversation: r.costPerConversation,
            adAccountName: r.adAccountName,
            unavailableReason: r.unavailableReason,
            syncedAt: r.syncedAt,
          },
        ]),
      );
    } catch (e) {
      if (this.isPageAdSpendSchemaMissing(e)) {
        this.logger.warn('cskh_page_ad_spend_daily chưa migrate — bỏ qua chi phí QC Page/Kênh');
        return new Map();
      }
      throw e;
    }
  }

  private isPageAdSpendSchemaMissing(e: unknown): boolean {
    const code = (e as { code?: string })?.code;
    return code === 'P2021' || /cskh_page_ad_spend_daily/i.test((e as Error).message || '');
  }

  /** Đồng bộ chi tiêu QC 1 Page / 1 ngày từ Marketing API → DB cache. */
  async syncPageAdSpendDaily(pageId: string, statDate: string, tenantId?: string) {
    if (!(await this.isPageAdSpendSchemaAvailable())) {
      return { pageId, statDate, ok: false, reason: 'schema_missing' as const };
    }

    const upsertEmpty = async (unavailableReason: string) => {
      try {
        await this.prisma.cskhPageAdSpendDaily.upsert({
          where: { pageId_statDate: { pageId, statDate } },
          create: {
            pageId,
            statDate,
            tenantId: tenantId ?? null,
            unavailableReason,
          },
          update: {
            spend: null,
            currency: null,
            messagingConversations: null,
            costPerConversation: null,
            adAccountId: null,
            adAccountName: null,
            unavailableReason,
            syncedAt: new Date(),
          },
        });
      } catch (e) {
        if (this.isPageAdSpendSchemaMissing(e)) return;
        throw e;
      }
    };

    const session = await this.resolveOAuthSessionForPage(pageId, tenantId);
    if (!session?.userAccessToken) {
      await upsertEmpty('oauth_required');
      return { pageId, statDate, ok: false, reason: 'oauth_required' as const };
    }

    const oauthMeta =
      (session.metadata as { adAccounts?: Array<{ id: string; name?: string }> } | null) ?? null;
    let activeAccounts: Array<{ id: string; name?: string }> = [];
    if (Array.isArray(oauthMeta?.adAccounts) && oauthMeta.adAccounts.length) {
      activeAccounts = oauthMeta.adAccounts;
    } else {
      try {
        activeAccounts = await this.ads.fetchAdAccounts(session.userAccessToken);
      } catch {
        await upsertEmpty('ads_read_missing');
        return { pageId, statDate, ok: false, reason: 'ads_read_missing' as const };
      }
    }
    if (!activeAccounts.length) {
      await upsertEmpty('no_ad_accounts');
      return { pageId, statDate, ok: false, reason: 'no_ad_accounts' as const };
    }

    const pageAccounts = await this.ads.filterAdAccountsForPage(
      pageId,
      session.userAccessToken,
      activeAccounts.slice(0, 3),
    );
    const accountsToTry = pageAccounts.length
      ? pageAccounts
      : activeAccounts.slice(0, 2);

    let best: Awaited<ReturnType<FacebookAdsService['fetchPageMessagingInsights']>> = null;
    for (const account of accountsToTry.slice(0, 3)) {
      const est = await this.ads.fetchPageMessagingInsights(
        account,
        pageId,
        session.userAccessToken,
        { since: statDate, until: statDate },
      );
      if (!est) continue;
      if (!best || (est.spend ?? 0) > (best.spend ?? 0)) best = est;
      if ((est.spend ?? 0) > 0) break;
    }

    if (!best || (best.spend == null && best.messagingConversations == null)) {
      await upsertEmpty('no_ads_for_page');
      return { pageId, statDate, ok: false, reason: 'no_ads_for_page' as const };
    }

    try {
      await this.prisma.cskhPageAdSpendDaily.upsert({
        where: { pageId_statDate: { pageId, statDate } },
        create: {
          pageId,
          statDate,
          tenantId: tenantId ?? null,
          spend: best.spend,
          currency: best.currency,
          messagingConversations: best.messagingConversations,
          costPerConversation: best.costPerConversation,
          adAccountId: best.adAccountId,
          adAccountName: best.adAccountName,
          unavailableReason: null,
        },
        update: {
          spend: best.spend,
          currency: best.currency,
          messagingConversations: best.messagingConversations,
          costPerConversation: best.costPerConversation,
          adAccountId: best.adAccountId,
          adAccountName: best.adAccountName,
          unavailableReason: null,
          syncedAt: new Date(),
        },
      });
    } catch (e) {
      if (this.isPageAdSpendSchemaMissing(e)) {
        return { pageId, statDate, ok: false, reason: 'schema_missing' as const };
      }
      throw e;
    }

    return {
      pageId,
      statDate,
      ok: true,
      spend: best.spend,
      currency: best.currency,
    };
  }

  /** Cron / nút đồng bộ — quét chi tiêu QC cho mọi kênh bật. */
  async syncAllPagesAdSpend(statDates: string[], tenantId?: string) {
    if (!(await this.isPageAdSpendSchemaAvailable())) {
      return { synced: 0, pages: 0, dates: [] as string[] };
    }
    if (await this.isInboxBackfillRunning(tenantId)) {
      this.logger.log('[page-ad-spend] Bỏ qua sync — đang có quét đầy đủ inbox');
      return { synced: 0, pages: 0, dates: statDates };
    }

    const uniqueDates = [...new Set(statDates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))];
    if (!uniqueDates.length) {
      return { synced: 0, pages: 0, dates: [] as string[] };
    }

    const pages = await this.prisma.facebookCskhConfig.findMany({
      where: { enabled: true, ...(tenantId ? { tenantId } : {}) },
      select: { pageId: true, pageName: true },
      orderBy: { pageName: 'asc' },
    });

    const delayMs = Number(process.env.CSKH_PAGE_AD_SYNC_DELAY_MS || 1_200);
    let synced = 0;

    for (const statDate of uniqueDates) {
      for (const page of pages) {
        try {
          const res = await this.syncPageAdSpendDaily(page.pageId, statDate, tenantId);
          if (res.ok) synced++;
        } catch (e) {
          this.logger.warn(
            `syncPageAdSpendDaily ${page.pageName || page.pageId} ${statDate}: ${(e as Error).message}`,
          );
        }
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    return { synced, pages: pages.length, dates: uniqueDates };
  }

  /** Kiểm tra / làm mới danh sách tài khoản QC từ token OAuth (dùng khi load Cài đặt). */
  private async refreshOAuthAdAccountsIfNeeded(fbUserId: string): Promise<{
    adAccountCount: number;
    adsReadConnected: boolean;
  }> {
    const session = await this.prisma.facebookOAuthSession.findUnique({
      where: { fbUserId },
      select: { fbUserId: true, userAccessToken: true, metadata: true },
    });
    if (!session?.userAccessToken) {
      return { adAccountCount: 0, adsReadConnected: false };
    }

    const meta =
      (session.metadata as {
        adAccounts?: unknown[];
        adAccountsCheckedAt?: string;
        pageCount?: number;
      } | null) ?? null;
    const cachedCount = Array.isArray(meta?.adAccounts) ? meta.adAccounts.length : 0;
    const checkedAt = meta?.adAccountsCheckedAt ? new Date(meta.adAccountsCheckedAt).getTime() : 0;
    const stale = !checkedAt || Date.now() - checkedAt > 3_600_000;
    if (cachedCount > 0 && !stale) {
      return { adAccountCount: cachedCount, adsReadConnected: true };
    }

    try {
      const adAccounts = await this.ads.fetchAdAccounts(session.userAccessToken);
      await this.prisma.facebookOAuthSession.update({
        where: { fbUserId: session.fbUserId },
        data: {
          metadata: {
            ...(meta ?? {}),
            adAccounts,
            adAccountsCheckedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      });
      return { adAccountCount: adAccounts.length, adsReadConnected: adAccounts.length > 0 };
    } catch (e) {
      this.logger.warn(
        `refreshOAuthAdAccountsIfNeeded ${fbUserId}: ${(e as Error).message}`,
      );
      return { adAccountCount: cachedCount, adsReadConnected: cachedCount > 0 };
    }
  }

  /** OAuth token đúng với Page — ưu tiên session có QC gán Page. */
  private async resolveOAuthSessionForPage(pageId: string, tenantId?: string) {
    const config = await this.prisma.facebookCskhConfig.findFirst({
      where: tenantId ? { pageId, tenantId } : { pageId },
      select: { metadata: true },
    });
    const oauthFbUserId = (config?.metadata as { oauthFbUserId?: string } | null)?.oauthFbUserId;

    const candidates = await this.prisma.facebookOAuthSession.findMany({
      where: tenantId ? { tenantId } : undefined,
      orderBy: { updatedAt: 'desc' },
      take: 5,
    });

    if (oauthFbUserId) {
      const pinned = candidates.find((s) => s.fbUserId === oauthFbUserId) ??
        (await this.prisma.facebookOAuthSession.findUnique({ where: { fbUserId: oauthFbUserId } }));
      if (pinned?.userAccessToken) {
        candidates.unshift(pinned);
      }
    }

    const seen = new Set<string>();
    for (const session of candidates) {
      if (!session?.userAccessToken || seen.has(session.fbUserId)) continue;
      seen.add(session.fbUserId);
      let accounts: Array<{ id: string; name?: string }> = [];
      const meta =
        (session.metadata as { adAccounts?: Array<{ id: string; name?: string }> } | null) ?? null;
      if (Array.isArray(meta?.adAccounts) && meta.adAccounts.length) {
        accounts = meta.adAccounts;
      } else {
        try {
          accounts = await this.ads.fetchAdAccounts(session.userAccessToken);
        } catch {
          continue;
        }
      }
      if (!accounts.length) continue;
      const linked = await this.ads.filterAdAccountsForPage(
        pageId,
        session.userAccessToken,
        accounts.slice(0, 6),
      );
      if (linked.length) return session;
    }

    return candidates.find((s) => s.userAccessToken) ?? null;
  }

  /** Thử lấy ad_id từ referral trên tin Graph (webhook cũ / heuristic không lưu ad_id). */
  private async tryResolveConversationAdId(conv: {
    id: string;
    pageId: string;
    adId: string | null;
  }): Promise<string | null> {
    if (conv.adId) return conv.adId;

    const config = await this.prisma.facebookCskhConfig.findFirst({
      where: { pageId: conv.pageId },
      select: { pageAccessToken: true },
    });
    const token = config?.pageAccessToken?.trim();
    if (!token) return null;

    const messages = await this.prisma.cskhInboxMessage.findMany({
      where: { conversationId: conv.id, fbMessageId: { not: null } },
      orderBy: { sentAt: 'asc' },
      take: 8,
      select: { fbMessageId: true },
    });

    for (const msg of messages) {
      const fbId = msg.fbMessageId?.trim();
      if (!fbId?.startsWith('m_')) continue;
      try {
        const data = await this.graph.graphRequest<{
          referral?: {
            source?: string;
            ad_id?: string;
            ads_context_data?: { ad_title?: string };
          };
        }>(`/${fbId}`, token, { fields: 'referral{source,ad_id,ads_context_data{ad_title}}' });
        const parsed = parseWebhookReferral(data.referral);
        if (!parsed.adId) continue;
        await this.prisma.cskhInboxConversation.update({
          where: { id: conv.id },
          data: {
            adId: parsed.adId,
            adTitle: parsed.adTitle ?? undefined,
            referralSource: parsed.referralSource ?? 'ADS',
            fromAd: true,
            referralAt: new Date(),
          },
        });
        return parsed.adId;
      } catch (e) {
        this.logger.debug(
          `tryResolveConversationAdId ${conv.id} msg=${fbId}: ${(e as Error).message}`,
        );
      }
    }
    return null;
  }

  /** Chi phí QC ước tính cho hội thoại ads — cần ads_read + ad_id từ webhook. */
  async getConversationAdInsights(conversationId: string, tenantId?: string): Promise<AdInsightsPayload> {
    const cacheKey = `${tenantId ?? '__all__'}:${conversationId}`;
    const cached = this.adInsightsConvCache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.adInsightsConvCacheTtlMs) {
      return cached.data;
    }

    const result = await this.loadConversationAdInsights(conversationId, tenantId);
    this.adInsightsConvCache.set(cacheKey, { at: Date.now(), data: result });
    return result;
  }

  private async loadConversationAdInsights(
    conversationId: string,
    tenantId?: string,
  ): Promise<AdInsightsPayload> {
    const conv = await findInboxConversationById(this.prisma, conversationId, tenantId);
    if (!conv) throw new NotFoundException('Hội thoại không tồn tại hoặc không có quyền');

    const empty = (reason: string): AdInsightsPayload => ({
      adId: conv.adId ?? '',
      adName: conv.adTitle,
      adsetName: null,
      campaignName: null,
      currency: null,
      spend: null,
      impressions: null,
      clicks: null,
      messagingConversations: null,
      costPerConversation: null,
      dateStart: null,
      dateStop: null,
      estimatedForThisConversation: null,
      localConversationCount: 0,
      unavailableReason: reason,
    });

    if (!conv.fromAd && conv.referralSource !== 'HEURISTIC') return empty('not_from_ad');

    const session = await this.resolveOAuthSessionForPage(conv.pageId, tenantId);
    if (!session?.userAccessToken) return empty('oauth_required');

    let effectiveAdId = conv.adId;
    if (!effectiveAdId && process.env.CSKH_AD_RESOLVE_ON_READ === 'true') {
      effectiveAdId = await this.tryResolveConversationAdId(conv);
    }

    if (effectiveAdId) {
      const referralAt = conv.referralAt ? new Date(conv.referralAt) : null;
      const since = referralAt ? new Date(referralAt.getTime() - 7 * 86_400_000) : undefined;
      const until = referralAt ? new Date(referralAt.getTime() + 7 * 86_400_000) : undefined;

      const localConversationCount = await this.prisma.cskhInboxConversation.count({
        where: { adId: effectiveAdId, ...(tenantId ? { tenantId } : {}) },
      });

      try {
        const insights = await this.ads.fetchAdInsights(effectiveAdId, session.userAccessToken, {
          since,
          until,
        });
        const estimatedForThisConversation =
          insights.costPerConversation ??
          (insights.spend != null && localConversationCount > 0
            ? insights.spend / localConversationCount
            : null);

        return {
          ...insights,
          adId: effectiveAdId,
          adName: insights.adName ?? conv.adTitle,
          localConversationCount,
          estimatedForThisConversation,
          unavailableReason: null,
          insightsScope: 'ad',
        };
      } catch (e) {
        const msg = (e as Error).message || '';
        const reason =
          /ads_read|permission|OAuthException/i.test(msg) ? 'ads_read_missing' : 'api_error';
        this.logger.warn(`getConversationAdInsights ${conversationId}: ${msg}`);
        return {
          ...empty(reason),
          adId: effectiveAdId,
          adName: conv.adTitle,
          localConversationCount,
        };
      }
    }

    // Không có ad_id — chỉ ước tính theo QC của Page này (không lấy camp/chi tiêu toàn tài khoản)
    const oauthMeta =
      (session.metadata as { adAccounts?: Array<{ id: string; name?: string }> } | null) ?? null;

    let activeAccounts: Array<{ id: string; name?: string; account_status?: number }> = [];
    if (Array.isArray(oauthMeta?.adAccounts) && oauthMeta.adAccounts.length) {
      activeAccounts = oauthMeta.adAccounts.map((a) => ({ id: a.id, name: a.name }));
    } else {
      try {
        activeAccounts = await this.ads.fetchAdAccounts(session.userAccessToken);
      } catch (e) {
        const msg = (e as Error).message || '';
        if (/ads_read|permission|OAuthException/i.test(msg)) {
          return empty('ads_read_missing');
        }
      }
    }

    const pageAccounts = await this.ads.filterAdAccountsForPage(
      conv.pageId,
      session.userAccessToken,
      activeAccounts.filter((a) => a.id).slice(0, 8) as Array<{
        id: string;
        name?: string;
        account_status?: number;
      }>,
    );

    let accountsToTry =
      pageAccounts.length > 0
        ? pageAccounts
        : activeAccounts.filter((a) => a.id).slice(0, 10);

    if (!accountsToTry.length) {
      return {
        ...empty('no_ad_accounts'),
        estimateNote:
          'Chưa thấy tài khoản QC trên OAuth. Vào Cài đặt → OAuth lại bằng admin Business Manager có quyền ads_read trên tài khoản chạy ads cho Page này.',
      };
    }

    // Ưu tiên tài khoản đã lọc theo Page — bỏ qua countPageAds (chậm) khi đã có danh sách
    if (pageAccounts.length > 0) {
      accountsToTry = pageAccounts;
    } else {
      const scored = await Promise.all(
        accountsToTry.slice(0, 4).map(async (account) => ({
          account,
          pageAdCount: account.id
            ? await this.ads.countPageAds(account.id, conv.pageId, session.userAccessToken)
            : 0,
        })),
      );
      accountsToTry = scored
        .sort((a, b) => b.pageAdCount - a.pageAdCount)
        .map((s) => s.account);
    }

    const usedPageFilterFallback = pageAccounts.length === 0 && accountsToTry.length > 0;
    const pageFallbackNote = usedPageFilterFallback
      ? ' Meta không trả danh sách Page↔QC — đang quét từng tài khoản OAuth.'
      : '';

    type PageEst = Awaited<ReturnType<FacebookAdsService['fetchPageMessagingInsights']>>;
    const insightResults = await Promise.all(
      accountsToTry.slice(0, 3).map((account) =>
        this.ads.fetchPageMessagingInsights(account, conv.pageId, session.userAccessToken),
      ),
    );
    let pageEstimate: PageEst = null;
    let bestPartial: PageEst = null;
    for (const est of insightResults) {
      if (!est) continue;
      if (est.costPerConversation != null) {
        pageEstimate = est;
        break;
      }
      if (
        est.spend != null &&
        est.spend > 0 &&
        (!bestPartial || (bestPartial.spend ?? 0) < est.spend)
      ) {
        bestPartial = est;
      }
    }

    if (!pageEstimate?.costPerConversation && bestPartial) {
      pageEstimate = bestPartial;
    }

    // Ưu tiên chi phí theo chiến dịch (khớp Ads Manager) thay vì TB cả Page
    if (pageEstimate?.campaignName && pageEstimate.adAccountId) {
      const campaignEst = await this.ads.fetchCampaignMessagingInsights(
        {
          id: pageEstimate.adAccountId,
          name: pageEstimate.adAccountName ?? undefined,
        },
        pageEstimate.campaignName,
        session.userAccessToken,
      );
      if (campaignEst?.costPerConversation != null) {
        const displayAdName = conv.adTitle?.trim() || pageEstimate.adName || null;
        return {
          adId: '',
          adName: displayAdName,
          adsetName: campaignEst.adsetName ?? pageEstimate.adsetName,
          campaignName: campaignEst.campaignName ?? pageEstimate.campaignName,
          currency: campaignEst.currency,
          spend: campaignEst.spend,
          impressions: null,
          clicks: null,
          messagingConversations: campaignEst.messagingConversations,
          costPerConversation: campaignEst.costPerConversation,
          dateStart: campaignEst.dateStart,
          dateStop: campaignEst.dateStop,
          estimatedForThisConversation: campaignEst.costPerConversation,
          localConversationCount: 0,
          unavailableReason: null,
          isPageLevelEstimate: false,
          insightsScope: 'campaign',
          connectedAdAccountId: campaignEst.adAccountId,
          connectedAdAccountName: campaignEst.adAccountName,
          estimateNote: null,
        };
      }
    }

    if (pageEstimate?.costPerConversation != null) {
      const displayAdName = conv.adTitle?.trim() || pageEstimate.adName || null;
      const displayCampaign = pageEstimate.campaignName || null;
      const displayAdset = pageEstimate.adsetName || null;
      return {
        adId: '',
        adName: displayAdName,
        adsetName: displayAdset,
        campaignName: displayCampaign,
        currency: pageEstimate.currency,
        spend: pageEstimate.spend,
        impressions: null,
        clicks: null,
        messagingConversations: pageEstimate.messagingConversations,
        costPerConversation: pageEstimate.costPerConversation,
        dateStart: pageEstimate.dateStart,
        dateStop: pageEstimate.dateStop,
        estimatedForThisConversation: pageEstimate.costPerConversation,
        localConversationCount: 0,
        unavailableReason: null,
        isPageLevelEstimate: true,
        insightsScope: 'page',
        connectedAdAccountId: pageEstimate.adAccountId,
        connectedAdAccountName: pageEstimate.adAccountName,
        estimateNote: null,
        topCampaigns: pageEstimate.topCampaigns?.length
          ? pageEstimate.topCampaigns
          : displayCampaign
            ? [{ campaignName: displayCampaign, spend: pageEstimate.spend, messagingConversations: pageEstimate.messagingConversations }]
            : undefined,
      };
    }

    if (pageEstimate?.spend != null && pageEstimate.spend > 0) {
      return {
        adId: '',
        adName: conv.adTitle,
        adsetName: null,
        campaignName: null,
        currency: pageEstimate.currency,
        spend: null,
        impressions: null,
        clicks: null,
        messagingConversations: pageEstimate.messagingConversations,
        costPerConversation: null,
        dateStart: pageEstimate.dateStart,
        dateStop: pageEstimate.dateStop,
        estimatedForThisConversation: null,
        localConversationCount: 0,
        unavailableReason: null,
        isPageLevelEstimate: true,
        insightsScope: 'page',
        connectedAdAccountId: pageEstimate.adAccountId,
        connectedAdAccountName: pageEstimate.adAccountName,
        estimateNote:
          'Page có chi tiêu QC nhưng Meta chưa trả số hội thoại messaging (30 ngày) — không tính được chi phí/tin.',
      };
    }

    return {
      ...empty('no_messaging_insights'),
      connectedAdAccountId: accountsToTry[0]?.id ?? null,
      connectedAdAccountName: accountsToTry[0]?.name ?? null,
      estimateNote: await this.buildNoMessagingInsightsNote(
        conv.pageId,
        session.userAccessToken,
        accountsToTry.slice(0, 6) as Array<{ id: string; name?: string }>,
        pageFallbackNote,
      ),
    };
  }

  /** Gợi ý OAuth khi không lấy được insights — phân biệt sai tài khoản vs Meta chưa trả số. */
  private async buildNoMessagingInsightsNote(
    pageId: string,
    userAccessToken: string,
    accounts: Array<{ id: string; name?: string }>,
    fallbackNote: string,
  ): Promise<string> {
    const withAds: string[] = [];
    for (const account of accounts) {
      if (!account.id) continue;
      try {
        const n = await this.ads.countPageAds(account.id, pageId, userAccessToken);
        if (n > 0) withAds.push(account.name || account.id);
      } catch {
        /* ignore */
      }
    }

    if (!withAds.length) {
      const names = accounts.map((a) => a.name || a.id).filter(Boolean).slice(0, 3).join(', ');
      return (
        `Không tìm thấy QC nào của Page này trên tài khoản OAuth${names ? ` (${names})` : ''}.` +
        ` Cần OAuth lại bằng admin BM — chọn đúng tài khoản QC đang chạy ads cho Page.${fallbackNote}`
      );
    }

    return (
      `Đã thấy QC của Page trên ${withAds.join(', ')} nhưng Meta chưa trả Insights messaging (30 ngày).` +
      ` Tin cũ không có mã QC nên không đối chiếu camp cụ thể.${fallbackNote}` +
      ` Thử OAuth lại nếu ads chạy trên tài khoản QC khác.`
    );
  }

  /** Số tin nhắn khách gửi đến (inbound) theo page trong khoảng ngày lịch VN (UTC+7). */
  private async loadPageInboundMessageStatsForRangeCached(
    tenantId: string | undefined,
    from: string,
    to: string,
    pageIds: string[],
  ) {
    if (!pageIds.length) return new Map<string, number>();
    if (from === to) {
      const cacheKey = `${tenantId ?? '__all__'}:${from}`;
      const bustAt = await this.redisQueue.getPageStatsCacheBustAt(tenantId);
      const cached = this.pageInboundDayCache.get(cacheKey);
      if (
        cached &&
        cached.at >= bustAt &&
        Date.now() - cached.at < this.pageInboundDayCacheTtlMs
      ) {
        return cached.data;
      }
      const data = await this.loadPageInboundMessageStatsForRange(from, to, pageIds);
      this.pageInboundDayCache.set(cacheKey, { at: Date.now(), data });
      return data;
    }
    return this.loadPageInboundMessageStatsForRange(from, to, pageIds);
  }

  private async loadPageStatsFromSummary(pageIds: string[]) {
    type Row = {
      pageId: string;
      messageCount: number;
      conversationCount: number;
      unreadConversationCount: number;
    };
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT
        page_id AS "pageId",
        message_count::int AS "messageCount",
        conversation_count::int AS "conversationCount",
        unread_conversation_count::int AS "unreadConversationCount"
      FROM cskh_page_message_totals
      WHERE page_id IN (${Prisma.join(pageIds)})
    `;
    return {
      convMap: new Map(rows.map((r) => [r.pageId, r.conversationCount])),
      unreadMap: new Map(rows.map((r) => [r.pageId, r.unreadConversationCount])),
      messageMap: new Map(rows.map((r) => [r.pageId, r.messageCount])),
    };
  }

  private async loadPageStatsBundleCached(
    tenantId: string | undefined,
    pageIds: string[],
    options?: { allowStaleDuringBackfill?: boolean },
  ) {
    const empty = {
      convMap: new Map<string, number>(),
      unreadMap: new Map<string, number>(),
      messageMap: new Map<string, number>(),
    };
    if (!pageIds.length) return empty;

    const cacheKey = `${tenantId ?? '__all__'}:bundle:${pageIds.length}`;
    const bustAt = await this.redisQueue.getPageStatsCacheBustAt(tenantId);
    const cached = this.pageTotalMsgStatsCache.get(cacheKey);
    const fresh =
      cached &&
      cached.at >= bustAt &&
      Date.now() - cached.at < this.pageTotalMsgStatsCacheTtlMs;
    if (fresh && cached.bundle) return cached.bundle;

    if (
      options?.allowStaleDuringBackfill &&
      cached?.bundle &&
      (await this.isInboxBackfillRunning(tenantId))
    ) {
      return cached.bundle;
    }

    if (await this.isPageMessageTotalsTableAvailable()) {
      const summary = await this.loadPageStatsFromSummary(pageIds);
      if (summary.messageMap.size > 0) {
        const found = new Set(summary.messageMap.keys());
        for (const id of pageIds) {
          if (!summary.messageMap.has(id)) summary.messageMap.set(id, 0);
          if (!summary.convMap.has(id)) summary.convMap.set(id, 0);
          if (!summary.unreadMap.has(id)) summary.unreadMap.set(id, 0);
        }
        this.pageTotalMsgStatsCache.set(cacheKey, { at: Date.now(), bundle: summary });
        const missing = pageIds.filter((id) => !found.has(id));
        if (missing.length) {
          void this.refreshPageMessageTotals(missing).catch(() => undefined);
        }
        return summary;
      }
      void this.refreshPageMessageTotals().catch(() => undefined);
    }

    const [convStats, messageMap] = await Promise.all([
      this.loadPageConversationStatsCombined(pageIds),
      this.loadPageTotalMessageStats(pageIds),
    ]);
    const bundle = { ...convStats, messageMap };
    this.pageTotalMsgStatsCache.set(cacheKey, { at: Date.now(), bundle });
    return bundle;
  }

  /** Hội thoại + chưa đọc theo page — 1 query thay vì 2 groupBy. */
  private async loadPageConversationStatsCombined(pageIds: string[]) {
    type Row = { pageId: string; conversationCount: number; unreadConversationCount: number };
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT
        page_id AS "pageId",
        COUNT(*)::int AS "conversationCount",
        COUNT(*) FILTER (WHERE unread_count > 0)::int AS "unreadConversationCount"
      FROM cskh_inbox_conversations
      WHERE page_id IN (${Prisma.join(pageIds)})
      GROUP BY page_id
    `;
    return {
      convMap: new Map(rows.map((r) => [r.pageId, r.conversationCount])),
      unreadMap: new Map(rows.map((r) => [r.pageId, r.unreadConversationCount])),
    };
  }

  private async isPageMessageTotalsTableAvailable(): Promise<boolean> {
    if (this.pageMessageTotalsTableAvailable != null) {
      return this.pageMessageTotalsTableAvailable;
    }
    try {
      await this.prisma.$queryRaw`SELECT 1 FROM cskh_page_message_totals LIMIT 1`;
      this.pageMessageTotalsTableAvailable = true;
    } catch (e) {
      if (this.isPageMessageTotalsTableMissing(e)) {
        this.pageMessageTotalsTableAvailable = false;
        this.logger.warn(
          'cskh_page_message_totals chưa migrate — Page/Kênh dùng COUNT chậm (chạy prisma/manual-page-stats.sql)',
        );
      } else {
        throw e;
      }
    }
    return this.pageMessageTotalsTableAvailable;
  }

  private isPageMessageTotalsTableMissing(e: unknown): boolean {
    const code = (e as { code?: string })?.code;
    return code === 'P2010' || code === '42P01' || /cskh_page_message_totals/i.test((e as Error).message || '');
  }

  /** Cập nhật bảng tổng hợp — gọi sau quét xong 1 kênh hoặc nền khi thiếu cache. */
  async refreshPageMessageTotals(pageIds?: string[]): Promise<void> {
    if (!(await this.isPageMessageTotalsTableAvailable())) return;
    const filter =
      pageIds?.length ?
        Prisma.sql`WHERE c.page_id IN (${Prisma.join(pageIds)})`
      : Prisma.empty;
    await this.prisma.$executeRaw`
      INSERT INTO cskh_page_message_totals (
        page_id, message_count, conversation_count, unread_conversation_count, refreshed_at
      )
      SELECT
        c.page_id,
        COUNT(m.id)::bigint,
        COUNT(DISTINCT c.id)::bigint,
        COUNT(DISTINCT c.id) FILTER (WHERE c.unread_count > 0)::bigint,
        NOW()
      FROM cskh_inbox_conversations c
      LEFT JOIN cskh_inbox_messages m ON m.conversation_id = c.id
      ${filter}
      GROUP BY c.page_id
      ON CONFLICT (page_id) DO UPDATE SET
        message_count = EXCLUDED.message_count,
        conversation_count = EXCLUDED.conversation_count,
        unread_conversation_count = EXCLUDED.unread_conversation_count,
        refreshed_at = EXCLUDED.refreshed_at
    `;
    if (pageIds?.length) {
      for (const key of [...this.pageTotalMsgStatsCache.keys()]) {
        this.pageTotalMsgStatsCache.delete(key);
      }
    } else {
      this.pageTotalMsgStatsCache.clear();
    }
  }

  /**
   * Thiếu cache chi tiêu QC cho ngày → đồng bộ nền từ Marketing API (không chặn response).
   * Trả true nếu vừa lên lịch sync.
   */
  private async schedulePageAdSpendSyncIfNeeded(
    statDate: string,
    tenantId: string | undefined,
    pageIds: string[],
    adSpendMap: Map<
      string,
      {
        spend: number | null;
        unavailableReason: string | null;
        syncedAt: Date | null;
      }
    >,
  ): Promise<boolean> {
    if (!(await this.isPageAdSpendSchemaAvailable())) return false;
    if (await this.isInboxBackfillRunning(tenantId)) return false;

    const scheduleKey = `${tenantId ?? '__all__'}:${statDate}`;
    const lastScheduled = this.pageAdSpendSyncScheduled.get(scheduleKey) ?? 0;
    const debounceMs = Number(process.env.CSKH_PAGE_AD_SYNC_DEBOUNCE_MS || 600_000);
    if (Date.now() - lastScheduled < debounceMs) return false;

    const covered = pageIds.filter((id) => {
      const ad = adSpendMap.get(id);
      return Boolean(ad?.syncedAt || ad?.unavailableReason);
    }).length;
    if (pageIds.length > 0 && covered >= pageIds.length * 0.85) return false;

    this.pageAdSpendSyncScheduled.set(scheduleKey, Date.now());
    void this.syncAllPagesAdSpend([statDate], tenantId)
      .then((result) => {
        this.logger.log(
          `[page-ad-spend] Nền xong ${statDate}: ${result.synced}/${result.pages} kênh`,
        );
        void this.bumpPageStatsCaches(tenantId);
      })
      .catch((e) => {
        this.logger.warn(
          `[page-ad-spend] Nền lỗi ${statDate}: ${(e as Error).message}`,
        );
      });
    return true;
  }

  private async loadPageInboundMessageStatsForRange(
    from: string,
    to: string,
    pageIds: string[],
  ) {
    if (!pageIds.length) return new Map<string, number>();
    const { start, end } = this.graph.vietnamDateRange(from, to);
    type StatRow = { pageId: string; inboundCount: number };
    const rows = await this.prisma.$queryRaw<StatRow[]>`
      SELECT
        c.page_id AS "pageId",
        COUNT(*)::int AS "inboundCount"
      FROM cskh_inbox_messages m
      INNER JOIN cskh_inbox_conversations c ON c.id = m.conversation_id
        AND c.page_id IN (${Prisma.join(pageIds)})
      WHERE (
          m.direction = 'inbound'
          OR m.sender_type = 'customer'
        )
        AND m.sent_at >= ${start}
        AND m.sent_at <= ${end}
      GROUP BY c.page_id
    `;
    return new Map(rows.map((r) => [r.pageId, r.inboundCount]));
  }

  /** Số tin nhắn khách gửi đến (inbound) theo page trong tháng lịch VN (UTC+7). */
  private async loadPageInboundMessageStats(month: string, pageIds: string[]) {
    if (!pageIds.length) return new Map<string, number>();
    const { from, to } = this.monthRangeDays(month);
    return this.loadPageInboundMessageStatsForRange(from, to, pageIds);
  }

  /** Tổng số tin nhắn (mọi chiều, mọi thời điểm) theo page. */
  private async loadPageTotalMessageStats(pageIds: string[]) {
    if (!pageIds.length) return new Map<string, number>();
    type StatRow = { pageId: string; totalCount: number };
    const rows = await this.prisma.$queryRaw<StatRow[]>`
      SELECT
        c.page_id AS "pageId",
        COUNT(*)::int AS "totalCount"
      FROM cskh_inbox_messages m
      INNER JOIN cskh_inbox_conversations c ON c.id = m.conversation_id
      WHERE c.page_id IN (${Prisma.join(pageIds)})
      GROUP BY c.page_id
    `;
    return new Map(rows.map((r) => [r.pageId, r.totalCount]));
  }

  private monthRangeDays(month: string): { from: string; to: string } {
    const [yearStr, monthStr] = month.split('-');
    const year = Number(yearStr);
    const monthNum = Number(monthStr);
    if (
      !Number.isFinite(year) ||
      !Number.isFinite(monthNum) ||
      monthNum < 1 ||
      monthNum > 12
    ) {
      throw new BadRequestException('Tháng không hợp lệ (YYYY-MM)');
    }
    const lastDay = new Date(year, monthNum, 0).getDate();
    return {
      from: `${month}-01`,
      to: `${month}-${String(lastDay).padStart(2, '0')}`,
    };
  }

  private pagePictureUrl(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== 'object') return null;
    const url = (metadata as { pictureUrl?: string }).pictureUrl;
    return typeof url === 'string' && url.startsWith('http') ? url : null;
  }

  private async enrichPagePictures(pageIds: string[]) {
    if (!pageIds.length) return;
    type PagePictureRow = {
      pageId: string;
      pageAccessToken: string;
      metadata: Prisma.JsonValue | null;
    };

    const batchSize = 12;
    for (let i = 0; i < pageIds.length; i += batchSize) {
      const chunk = pageIds.slice(i, i + batchSize);
      const configs: PagePictureRow[] = await this.prisma.facebookCskhConfig.findMany({
        where: { pageId: { in: chunk } },
        select: { pageId: true, pageAccessToken: true, metadata: true },
      });
      await Promise.all(
        configs.map(async (cfg) => {
          const url = await this.graph.getPagePictureUrl(cfg.pageId, cfg.pageAccessToken);
          if (!url) return;
          const prev = (cfg.metadata as Record<string, unknown>) || {};
          await this.prisma.facebookCskhConfig.update({
            where: { pageId: cfg.pageId },
            data: {
              metadata: { ...prev, pictureUrl: url } as Prisma.InputJsonValue,
            },
          });
        }),
      );
    }
  }

  async savePageConfig(
    data: {
      pageId: string;
      pageName?: string;
      pageAccessToken: string;
      metadata?: Record<string, unknown>;
    },
    tenantId?: string,
  ) {
    const pageId = data.pageId?.trim();
    const token = data.pageAccessToken?.trim();
    if (!pageId || !/^\d+$/.test(pageId)) {
      throw new BadRequestException('pageId phải là số (Facebook Page ID)');
    }
    if (!token || token.length < 20) {
      throw new BadRequestException('pageAccessToken không hợp lệ');
    }
    const metadataJson =
      data.metadata === undefined ? undefined : (data.metadata as Prisma.InputJsonValue);
    const row = await this.prisma.facebookCskhConfig.upsert({
      where: { pageId },
      create: {
        pageId,
        pageName: data.pageName?.trim() || null,
        pageAccessToken: token,
        enabled: true,
        metadata: metadataJson,
        tenantId,
      },
      update: {
        pageName: data.pageName?.trim() || undefined,
        pageAccessToken: token,
        metadata: metadataJson,
        tenantId,
      },
    });

    // Auto subscribe to webhooks
    await this.subscribePageToWebhook(pageId, token).catch((e) => {
      this.logger.error(`Auto subscribe failed for page ${pageId}: ${e.message}`);
    });

    return {
      pageId: row.pageId,
      pageName: row.pageName,
      enabled: row.enabled,
      updatedAt: row.updatedAt,
    };
  }

  async setPageEnabled(pageId: string, enabled: boolean, tenantId?: string) {
    const where = tenantId ? { pageId, tenantId } : { pageId };
    const result = await this.prisma.facebookCskhConfig.updateMany({
      where,
      data: { enabled },
    });
    if (result.count === 0) {
      throw new NotFoundException('Không tìm thấy page hoặc không có quyền');
    }
    return { pageId, enabled };
  }

  async setPagesEnabledBulk(enabled: boolean, pageIds?: string[], tenantId?: string) {
    const ids = pageIds?.map((id) => id.trim()) || [];
    const where: any = tenantId ? { tenantId } : {};
    if (ids.length) {
      where.pageId = { in: ids };
    }
    const result = await this.prisma.facebookCskhConfig.updateMany({
      where,
      data: { enabled },
    });
    return { updated: result.count, enabled };
  }

  async deletePage(pageId: string, tenantId?: string) {
    const where = tenantId ? { pageId, tenantId } : { pageId };
    const result = await this.prisma.facebookCskhConfig.deleteMany({
      where,
    });
    if (result.count === 0) {
      throw new NotFoundException('Không tìm thấy page hoặc không có quyền');
    }
    return { ok: true, pageId };
  }

  private async exchangeCodeForUserToken(code: string): Promise<string> {
    const redirectUri = getFacebookOAuthRedirectUri();
    const shortRes = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
      params: {
        client_id: getFacebookAppId(),
        client_secret: getFacebookAppSecret(),
        redirect_uri: redirectUri,
        code,
      },
      timeout: 30000,
    });
    const shortToken = shortRes.data?.access_token as string | undefined;
    if (!shortToken) throw new BadRequestException('Meta không trả access_token');

    const longRes = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: getFacebookAppId(),
        client_secret: getFacebookAppSecret(),
        fb_exchange_token: shortToken,
      },
      timeout: 30000,
    });
    const longToken = longRes.data?.access_token as string | undefined;
    if (!longToken) throw new BadRequestException('Không đổi được long-lived token');
    return longToken;
  }

  private async fetchManagedPages(userAccessToken: string) {
    type FbPage = {
      id: string;
      name: string;
      access_token: string;
      tasks?: string[];
      picture?: { data?: { url?: string } };
    };
    type FbAccountsResponse = { data?: FbPage[]; paging?: { next?: string } };

    const pages: FbPage[] = [];
    let nextUrl: string | null = `${GRAPH_BASE}/me/accounts`;
    let useParams = true;
    const params: Record<string, string | number> = {
      fields: 'id,name,access_token,tasks,picture{url}',
      limit: 100,
      access_token: userAccessToken,
    };

    while (nextUrl) {
      const res: { data: FbAccountsResponse } = await axios.get<FbAccountsResponse>(nextUrl, {
        params: useParams ? params : undefined,
        timeout: 60000,
      });
      useParams = false;
      const body: FbAccountsResponse = res.data;
      if (Array.isArray(body.data)) pages.push(...body.data);
      nextUrl = body.paging?.next ?? null;
    }
    return pages;
  }

  private async upsertPagesFromAccounts(
    accounts: Array<{
      id: string;
      name: string;
      access_token: string;
      tasks?: string[];
      picture?: { data?: { url?: string } };
    }>,
    source: 'oauth' | 'refresh',
    tenantId?: string,
    oauthFbUserId?: string,
  ) {
    const validAccounts = accounts.filter((acc) => acc.id && acc.access_token);
    
    // Process all pages concurrently using Promise.all
    const results = await Promise.all(
      validAccounts.map(async (acc) => {
        try {
          const canMessage = !acc.tasks?.length || acc.tasks.includes('MESSAGING');
          const pictureUrl = acc.picture?.data?.url ?? null;
          const existing = await this.prisma.facebookCskhConfig.findUnique({
            where: { pageId: acc.id },
            select: { metadata: true },
          });
          const prevMeta = (existing?.metadata as Record<string, unknown>) || {};
          const meta = {
            ...prevMeta,
            connectedVia: source,
            tasks: acc.tasks || [],
            ...(pictureUrl ? { pictureUrl } : {}),
            ...(oauthFbUserId ? { oauthFbUserId } : {}),
            refreshedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue;

          await this.prisma.facebookCskhConfig.upsert({
            where: { pageId: acc.id },
            create: {
              pageId: acc.id,
              pageName: acc.name || null,
              pageAccessToken: acc.access_token,
              enabled: canMessage,
              tenantId,
              metadata: {
                connectedVia: source,
                tasks: acc.tasks || [],
                ...(pictureUrl ? { pictureUrl } : {}),
                ...(oauthFbUserId ? { oauthFbUserId } : {}),
              } as Prisma.InputJsonValue,
            },
            update: {
              pageName: acc.name || undefined,
              pageAccessToken: acc.access_token,
              enabled: canMessage,
              tenantId,
              metadata: meta,
            },
          });

          // Webhook subscribe chạy nền — không chặn OAuth redirect
          void this.subscribePageToWebhook(acc.id, acc.access_token).catch((e) => {
            this.logger.error(`Auto subscribe failed for page ${acc.id} via OAuth: ${e.message}`);
          });

          return true;
        } catch (e: any) {
          this.logger.error(`Failed to upsert page ${acc.id} via ${source}: ${e.message}`);
          return false;
        }
      }),
    );

    const savedCount = results.filter(Boolean).length;
    return savedCount;
  }

  async handleOAuthCallback(code: string, state: string) {
    const parsed = verifyOAuthState(state);
    if (!parsed) throw new BadRequestException('OAuth state không hợp lệ');

    const tenantId = parsed.tenantId;
    const userAccessToken = await this.exchangeCodeForUserToken(code);
    const meRes = await axios.get(`${GRAPH_BASE}/me`, {
      params: { fields: 'id,name', access_token: userAccessToken },
      timeout: 15_000,
    });
    const fbUserId = String(meRes.data?.id || '');
    const fbUserName = (meRes.data?.name as string | undefined) || null;
    if (!fbUserId) throw new BadRequestException('Không lấy được Facebook user id');

    await this.prisma.facebookOAuthSession.upsert({
      where: { fbUserId },
      create: {
        fbUserId,
        fbUserName,
        userAccessToken,
        tenantId,
        metadata: {
          syncStatus: 'running',
          syncError: null,
          pageCount: 0,
          adAccounts: [],
          syncStartedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
      update: {
        fbUserName,
        userAccessToken,
        tenantId,
        metadata: {
          syncStatus: 'running',
          syncError: null,
          pageCount: 0,
          adAccounts: [],
          syncStartedAt: new Date().toISOString(),
          reconnectedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    void this.finishOAuthCallbackInBackground(fbUserId, fbUserName, userAccessToken, tenantId);

    return {
      returnUrl: parsed.returnUrl || this.defaultOAuthReturnUrl(),
      pageCount: 0,
      fbUserName,
      syncing: true,
    };
  }

  private finishOAuthCallbackInBackground(
    fbUserId: string,
    fbUserName: string | null,
    userAccessToken: string,
    tenantId?: string,
  ): void {
    if (this.oauthSyncInFlight.has(fbUserId)) return;
    this.oauthSyncInFlight.add(fbUserId);

    void (async () => {
      try {
        const accounts = await this.fetchManagedPages(userAccessToken);
        if (!accounts.length) {
          await this.prisma.facebookOAuthSession.update({
            where: { fbUserId },
            data: {
              metadata: {
                syncStatus: 'failed',
                syncError:
                  'Tài khoản Facebook không có Page nào — cần quyền quản trị Page trong Business Manager',
                pageCount: 0,
                adAccounts: [],
                syncFinishedAt: new Date().toISOString(),
              } as Prisma.InputJsonValue,
            },
          });
          return;
        }

        let adAccounts: Array<{ id: string; name?: string; account_id?: string; currency?: string }> =
          [];
        try {
          adAccounts = await this.ads.fetchAdAccounts(userAccessToken);
        } catch (e) {
          this.logger.warn(
            `Không lấy được ad accounts (cần quyền ads_read + OAuth lại): ${(e as Error).message}`,
          );
        }

        const saved = await this.upsertPagesFromAccounts(accounts, 'oauth', tenantId, fbUserId);

        await this.prisma.facebookOAuthSession.update({
          where: { fbUserId },
          data: {
            metadata: {
              syncStatus: 'done',
              syncError: null,
              pageCount: saved,
              adAccounts,
              adAccountsCheckedAt: new Date().toISOString(),
              syncFinishedAt: new Date().toISOString(),
            } as Prisma.InputJsonValue,
          },
        });

        this.logger.log(`Facebook OAuth background: ${saved} pages for ${fbUserName || fbUserId}`);
        this.invalidatePageListLiteCache(tenantId);
      } catch (e) {
        const msg = (e as Error).message || 'OAuth sync failed';
        this.logger.error(`finishOAuthCallbackInBackground ${fbUserId}: ${msg}`);
        await this.prisma.facebookOAuthSession
          .update({
            where: { fbUserId },
            data: {
              metadata: {
                syncStatus: 'failed',
                syncError: msg,
                syncFinishedAt: new Date().toISOString(),
              } as Prisma.InputJsonValue,
            },
          })
          .catch(() => undefined);
      } finally {
        this.oauthSyncInFlight.delete(fbUserId);
      }
    })();
  }

  async refreshPagesFromOAuth(tenantId?: string) {
    const session = await this.prisma.facebookOAuthSession.findFirst({
      where: tenantId ? { tenantId } : undefined,
      orderBy: { updatedAt: 'desc' },
    });
    if (!session) {
      throw new NotFoundException('Chưa kết nối OAuth — bấm "Kết nối Facebook" trước');
    }
    const accounts = await this.fetchManagedPages(session.userAccessToken);
    const saved = await this.upsertPagesFromAccounts(
      accounts,
      'refresh',
      session.tenantId || tenantId,
      session.fbUserId,
    );
    const adStats = await this.refreshOAuthAdAccountsIfNeeded(session.fbUserId);
    this.invalidatePageListLiteCache(session.tenantId || tenantId);
    return {
      pageCount: saved,
      oauthUser: session.fbUserName || session.fbUserId,
      adAccountCount: adStats.adAccountCount,
      adsReadConnected: adStats.adsReadConnected,
    };
  }

  private async enabledPages(tenantId?: string): Promise<EnabledFacebookPage[]> {
    return this.prisma.facebookCskhConfig.findMany({
      where: { enabled: true, tenantId: tenantId || undefined },
      orderBy: { pageName: 'asc' },
      select: { pageId: true, pageName: true, pageAccessToken: true },
    });
  }

  /** Mọi Page đã kết nối — dùng khi chấm điểm (chọn kênh trên FE). */
  private async allPages(tenantId?: string): Promise<EnabledFacebookPage[]> {
    return this.prisma.facebookCskhConfig.findMany({
      where: tenantId ? { tenantId } : undefined,
      orderBy: { pageName: 'asc' },
      select: { pageId: true, pageName: true, pageAccessToken: true },
    });
  }

  /** Khoảng ngày quét audit — mặc định N ngày gần nhất (VN). */
  buildAuditDateRange(lookbackDays = this.auditDefaultLookbackDays): {
    auditDateFrom: string;
    auditDateTo: string;
  } {
    const days = Math.max(1, Math.floor(lookbackDays));
    const today = new Date();
    const from = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
    return {
      auditDateFrom: from.toISOString().split('T')[0],
      auditDateTo: today.toISOString().split('T')[0],
    };
  }

  /** Mọi kênh đã kết nối — dùng cho cron ban đêm. */
  async listConnectedPages(tenantId?: string) {
    return this.prisma.facebookCskhConfig.findMany({
      where: tenantId ? { tenantId } : undefined,
      orderBy: { pageName: 'asc' },
      select: {
        pageId: true,
        pageName: true,
        pageAccessToken: true,
        tenantId: true,
        enabled: true,
      },
    });
  }

  getAuditCronDefaults() {
    return {
      maxConversations: this.auditCronMax,
      lookbackDays: this.auditDefaultLookbackDays,
    };
  }

  async createJob(type: 'monitor' | 'audit', tenantId?: string) {
    const initialSummary =
      type === 'audit'
        ? ({ phase: 'fetch', fetched: 0, pagesProcessed: 0, pagesTotal: 0 } as Prisma.InputJsonValue)
        : undefined;
    return this.prisma.cskhJobRun.create({
      data: { type, status: 'running', summary: initialSummary, tenantId },
    });
  }

  /** Hủy job kẹt (vd. user tắt AI service giữa chừng). */
  async releaseStaleJobs(type: 'monitor' | 'audit', maxAgeMs = 30 * 60 * 1000, tenantId?: string) {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const where: any = { type, status: 'running', startedAt: { lt: cutoff } };
    if (tenantId) {
      where.tenantId = tenantId;
    }
    const stale = await this.prisma.cskhJobRun.findMany({
      where,
      select: { id: true },
    });
    for (const j of stale) {
      this.activeJobs.delete(j.id);
    }
    await this.prisma.cskhJobRun.updateMany({
      where,
      data: {
        status: 'failed',
        error: 'Job quá hạn — đã hủy tự động (có thể do AI service bị tắt)',
        finishedAt: new Date(),
      },
    });
  }

  async findRunningJob(type: 'monitor' | 'audit', tenantId?: string) {
    const where: any = { type, status: 'running' };
    if (tenantId) {
      where.tenantId = tenantId;
    }
    return this.prisma.cskhJobRun.findFirst({
      where,
      orderBy: { startedAt: 'desc' },
    });
  }

  /** Trạng thái job — worker kiểm tra trước khi chạy từ Redis queue. */
  async findJobStatus(jobId: string): Promise<{ status: string } | null> {
    return this.prisma.cskhJobRun.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
  }

  async getRunningJob(type: 'monitor' | 'audit', tenantId?: string) {
    const running = await this.findRunningJob(type, tenantId);
    if (!running) return null;
    return this.getJob(running.id, tenantId);
  }

  async updateJobProgress(jobId: string, summary: Record<string, unknown>) {
    const jsonSummary = JSON.stringify(summary);
    try {
      await this.prisma.$executeRaw`
        UPDATE cskh_job_runs
        SET summary = COALESCE(summary, '{}'::jsonb) || CAST(${jsonSummary} AS jsonb)
        WHERE id = CAST(${jobId} AS uuid) AND status = 'running'
      `;
    } catch (err) {
      this.logger.error(`Lỗi updateJobProgress job ${jobId}: ${(err as Error).message}`);
    }
  }

  private async runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<void>,
  ) {
    await this.runWithConcurrencyStoppable(items, concurrency, fn, async () => false);
  }

  private async runWithConcurrencyStoppable<T>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<void>,
    shouldStop: () => boolean | Promise<boolean>,
  ): Promise<{ stoppedEarly: boolean }> {
    if (!items.length) return { stoppedEarly: false };

    let stoppedEarly = false;
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(concurrency, 1), items.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        if (await shouldStop()) {
          stoppedEarly = true;
          return;
        }
        if (nextIndex >= items.length) return;
        const index = nextIndex++;
        await fn(items[index], index);
      }
    });
    await Promise.all(workers);
    if (!stoppedEarly && (await shouldStop())) stoppedEarly = true;
    return { stoppedEarly };
  }

  async finishJob(
    jobId: string,
    status: 'done' | 'failed' | 'paused',
    summary?: Record<string, unknown>,
    error?: string,
  ) {
    const existing = await this.prisma.cskhJobRun.findUnique({
      where: { id: jobId },
      select: { status: true, summary: true, error: true },
    });
    if (!existing || existing.status !== 'running') {
      this.activeJobs.delete(jobId);
      await this.redisQueue.clearAuditPauseRequested(jobId);
      return existing;
    }

    this.activeJobs.delete(jobId);
    await this.redisQueue.clearAuditPauseRequested(jobId);
    const merged = {
      ...((existing.summary as Record<string, unknown> | null) ?? {}),
      ...(summary ?? {}),
    };
    return this.prisma.cskhJobRun.update({
      where: { id: jobId },
      data: {
        status,
        summary: merged as Prisma.InputJsonValue,
        error: error ? toUserFacingError(error) : null,
        finishedAt: new Date(),
      },
    });
  }

  async getJob(jobId: string, tenantId?: string) {
    const job = await this.prisma.cskhJobRun.findFirst({
      where: tenantId ? { id: jobId, tenantId } : { id: jobId },
      include: {
        monitorItems: {
          where: tenantId ? { needsReply: true, tenantId } : { needsReply: true },
          orderBy: { updatedAt: 'desc' },
        },
      },
    });
    if (!job) throw new NotFoundException('Job không tồn tại hoặc không có quyền');
    return {
      ...job,
      error: job.error ? toUserFacingError(job.error) : null,
    };
  }

  async getLatestMonitor(tenantId?: string) {
    const job = await this.prisma.cskhJobRun.findFirst({
      where: tenantId ? { type: 'monitor', status: 'done', tenantId } : { type: 'monitor', status: 'done' },
      orderBy: { finishedAt: 'desc' },
      include: {
        monitorItems: { 
          where: tenantId ? { needsReply: true, tenantId } : { needsReply: true }, 
          orderBy: { updatedAt: 'desc' } 
        },
      },
    });
    return job;
  }

  private buildMonitorItem(
    config: { pageId: string },
    pageName: string | null,
    conv: FbConversation,
    messages: FbMessage[],
  ) {
    let { customerName } = this.graph.participantInfo(conv.participants, config.pageId);
    if (customerName === 'Khách hàng' && messages.length) {
      const fromCustomer = messages.find((m) => String(m.from?.id) !== String(config.pageId));
      customerName = fromCustomer?.from?.name || customerName;
    }
    const noReply = this.graph.needsReply(messages, config.pageId);
    return {
      pageId: config.pageId,
      pageName,
      conversationId: conv.id,
      customerName,
      lastMessage: messages[0]?.message || null,
      needsReply: noReply,
      updatedAt: conv.updated_time ? new Date(conv.updated_time) : null,
    };
  }

  private async fetchMonitorConversations(
    pageId: string,
    token: string,
    maxCount: number,
  ) {
    try {
      return await this.graph.fetchConversationsForMonitor(pageId, token, maxCount);
    } catch (e) {
      this.logger.warn(
        `Monitor fallback N+1 cho Page ${pageId}: ${(e as Error).message}`,
      );
      const conversations = await this.graph.fetchConversations(pageId, token, maxCount);
      await this.runWithConcurrency<FbConversation>(conversations, this.monitorMsgConcurrency, async (conv) => {
        try {
          const messages = await this.graph.fetchMessages(conv.id, token, 1);
          conv.messages = { data: messages };
        } catch (err) {
          this.logger.warn(`Không đọc messages ${conv.id}: ${(err as Error).message}`);
          conv.messages = { data: [] };
        }
      });
      return conversations;
    }
  }

  async runMonitorJob(jobId: string, maxConversations?: number) {
    const maxFetch = maxConversations ?? this.monitorMax;
    try {
      const job = await this.prisma.cskhJobRun.findUnique({ where: { id: jobId } });
      const pages = await this.enabledPages(job?.tenantId || undefined);
      if (!pages.length) {
        throw new BadRequestException('Chưa có Page nào được bật');
      }
      if (pages.length > this.monitorMaxPages) {
        throw new BadRequestException(
          `Đang bật ${pages.length} Page — tối đa ${this.monitorMaxPages} Page/lần. Vào tab Cấu hình, tắt Page không cần monitor.`,
        );
      }

      type EnabledPage = EnabledFacebookPage;

      let totalConversations = 0;
      let totalNoReply = 0;
      const items: Array<{
        pageId: string;
        pageName: string | null;
        conversationId: string;
        customerName: string | null;
        lastMessage: string | null;
        needsReply: boolean;
        updatedAt: Date | null;
      }> = [];

      let pageErrors = 0;
      let pagesProcessed = 0;

      await this.updateJobProgress(jobId, {
        phase: 'scanning',
        pagesTotal: pages.length,
        pagesProcessed: 0,
        maxConversationsPerPage: maxFetch,
      });

      await this.runWithConcurrency<EnabledPage>(
        pages,
        this.monitorPageConcurrency,
        async (config) => {
          try {
            const pageName = config.pageName;
            const conversations = await this.fetchMonitorConversations(
              config.pageId,
              config.pageAccessToken,
              maxFetch,
            );
            totalConversations += conversations.length;

            const pageItems = conversations.map((conv) => {
              const messages = this.graph.latestMessages(conv);
              const item = this.buildMonitorItem(config, pageName, conv, messages);
              if (item.needsReply) totalNoReply++;
              return item;
            });
            items.push(...pageItems);

            if (pageItems.length) {
              await this.prisma.cskhMonitorItem.createMany({
                data: pageItems.map((item) => ({
                  jobRunId: jobId,
                  pageId: item.pageId,
                  pageName: item.pageName,
                  conversationId: item.conversationId,
                  customerName: item.customerName,
                  lastMessage: item.lastMessage,
                  needsReply: item.needsReply,
                  updatedAt: item.updatedAt,
                })),
              });
            }
          } catch (e) {
            pageErrors++;
            this.logger.warn(
              `Monitor bỏ qua Page ${config.pageName || config.pageId}: ${(e as Error).message}`,
            );
          } finally {
            pagesProcessed++;
            await this.updateJobProgress(jobId, {
              phase: 'scanning',
              pagesTotal: pages.length,
              pagesProcessed,
              currentPage: config.pageName || config.pageId,
              totalConversations,
              totalNoReply,
              pageErrors,
              maxConversationsPerPage: maxFetch,
            });
            this.logger.log(
              `Monitor job ${jobId.slice(0, 8)}: ${pagesProcessed}/${pages.length} Page (${config.pageName || config.pageId})`,
            );
          }
        },
      );

      if (!items.length && pageErrors > 0) {
        throw new BadRequestException(
          `Không đọc được inbox — thiếu quyền pages_read_engagement. Meta App → Permissions → bật quyền, rồi OAuth lại.`,
        );
      }

      await this.finishJob(jobId, 'done', {
        totalConversations,
        totalNoReply,
        pageCount: pages.length,
        pageErrors,
        maxConversationsPerPage: maxFetch,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.finishJob(jobId, 'failed', undefined, msg);
      this.logger.error(`Monitor job ${jobId} failed: ${msg}`);
    }
  }

  async fetchConversationsForAuditFromDb(
    pageId: string,
    auditDateFrom: string,
    auditDateTo?: string,
    msgLimit = 300,
    onProgress?: (scanned: number, matched: number) => void | Promise<void>,
    convFilter?: (conv: FbConversation) => 'include' | 'exclude' | 'stop',
    maxNewMatches = 0,
    onMatch?: (conv: FbConversation) => void | Promise<void>,
    shouldAbort?: () => boolean | Promise<boolean>,
  ): Promise<FbConversation[]> {
    const auditDateToResolved = auditDateTo?.trim() || auditDateFrom;
    const { start, end } = this.graph.vietnamDateRange(auditDateFrom, auditDateToResolved);

    // 1. Fetch conversations for this page from local database
    const dbConversations = await this.prisma.cskhInboxConversation.findMany({
      where: {
        pageId,
        messages: {
          some: {
            sentAt: {
              gte: start,
              lte: end,
            },
          },
        },
      },
      orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
      select: {
        id: true,
        fbConversationId: true,
        participantPsid: true,
        customerName: true,
        lastMessageAt: true,
        updatedAt: true,
      },
    });

    const matched: FbConversation[] = [];
    let scanned = 0;

    for (const dbConv of dbConversations) {
      if (shouldAbort && (await shouldAbort())) break;
      scanned++;

      const participants = {
        data: [
          { id: pageId, name: 'Page' },
          { id: dbConv.participantPsid, name: dbConv.customerName || 'Khách hàng' },
        ],
      };

      const conv: FbConversation = {
        id: dbConv.fbConversationId || dbConv.id,
        updated_time: dbConv.lastMessageAt
          ? dbConv.lastMessageAt.toISOString()
          : dbConv.updatedAt.toISOString(),
        participants,
        messages: { data: [] }, // Load messages just-in-time inside worker to prevent OOM
      };
      (conv as any).dbConversationId = dbConv.id;

      if (convFilter) {
        const decision = convFilter(conv);
        if (decision === 'exclude') continue;
        if (decision === 'stop') break;
      }

      matched.push(conv);
      if (onMatch) {
        await onMatch(conv);
      }

      if (scanned % 10 === 0 && onProgress) {
        await onProgress(scanned, matched.length);
      }

      if (maxNewMatches > 0 && matched.length >= maxNewMatches) {
        break;
      }
    }

    if (onProgress) {
      await onProgress(scanned, matched.length);
    }

    return matched;
  }

  private countAuditedForPage(auditedKeys: Set<string>, pageId: string): number {
    let count = 0;
    const prefix = `${pageId}:`;
    for (const key of auditedKeys) {
      if (key.startsWith(prefix)) count++;
    }
    return count;
  }

  /** Chờ inbox realtime nhường Graph — thoát sớm nếu audit bị pause/hủy. */
  private async waitForInboxUnlessAuditStopped(jobId: string, maxWaitMs = 90_000): Promise<boolean> {
    if (!shouldAuditYieldToInbox()) return true;
    const start = Date.now();
    while (await this.redisQueue.shouldYieldGraphToInbox()) {
      if (await this.shouldStopAuditJob(jobId)) return false;
      if (Date.now() - start > maxWaitMs) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return true;
  }

  async runAuditJob(
    jobId: string,
    options: {
      auditDate?: string;
      auditDateFrom?: string;
      auditDateTo?: string;
      maxConversations?: number;
      force?: boolean;
      pageId?: string;
    },
  ) {
    const jobRow = await this.prisma.cskhJobRun.findUnique({
      where: { id: jobId },
      select: { status: true, tenantId: true },
    });
    if (!jobRow || jobRow.status !== 'running') {
      this.logger.log(
        `Audit job ${jobId.slice(0, 8)} bỏ qua — trạng thái=${jobRow?.status ?? 'missing'}`,
      );
      return;
    }

    this.activeJobs.set(jobId, { pauseRequested: false });
    const auditDateFrom = (options.auditDateFrom || options.auditDate || '').trim();
    const auditDateTo = (options.auditDateTo || options.auditDateFrom || options.auditDate || '')
      .trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(auditDateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(auditDateTo)) {
      throw new BadRequestException('Ngày bắt đầu / kết thúc không hợp lệ (YYYY-MM-DD)');
    }
    if (auditDateFrom > auditDateTo) {
      throw new BadRequestException('Ngày bắt đầu phải trước hoặc bằng ngày kết thúc');
    }
    const maxConversations = options.maxConversations;
    const force = Boolean(options.force);
    const pageId = options.pageId;
    const cap =
      maxConversations && maxConversations > 0
        ? maxConversations
        : this.auditMax > 0
          ? this.auditMax
          : 0;
    try {
      const job = jobRow;
      const pageIdTrimmed = pageId?.trim() || undefined;
      let pages: EnabledFacebookPage[] = [];

      if (pageIdTrimmed) {
        const all = await this.allPages(job?.tenantId || undefined);
        pages = all.filter((p) => p.pageId === pageIdTrimmed);
        if (!pages.length) {
          throw new BadRequestException('Kênh không tồn tại — kết nối lại Facebook ở tab Cài đặt');
        }
      } else {
        pages = await this.allPages(job?.tenantId || undefined);
        if (!pages.length) {
          throw new BadRequestException('Không có kênh nào được kết nối để chấm điểm');
        }
      }

      type AuditTask = {
        config: EnabledFacebookPage;
        conv: FbConversation;
      };

      const pageIds = pages.map((p) => p.pageId);
      const auditedKeys = force
        ? new Set<string>()
        : await this.loadAuditedConversationKeys(auditDateFrom, auditDateTo, pageIds);

      const scanAllPages = !pageIdTrimmed;

      // Một kênh: trừ cuộc đã chấm khỏi cap. Tất cả kênh: cap áp dụng riêng từng page.
      if (!scanAllPages && !force && cap > 0) {
        const alreadyAuditedCount = this.countAuditedForPage(auditedKeys, pageIdTrimmed!);
        const effectiveCap = Math.max(0, cap - alreadyAuditedCount);
        if (effectiveCap === 0) {
          await this.finishJob(jobId, 'done', {
            auditDate: auditDateFrom,
            auditDateFrom,
            auditDateTo,
            pageId: pageIdTrimmed,
            allAlreadyAudited: true,
            skippedAlready: alreadyAuditedCount,
            pageCount: pages.length,
            audited: 0,
            maxConversations: cap,
          });
          this.activeJobs.delete(jobId);
          return;
        }
        this.logger.log(
          `Audit job ${jobId.slice(0, 8)}: tiếp tục ${effectiveCap} cuộc còn lại (${alreadyAuditedCount}/${cap} đã chấm)`,
        );
      }

      const queue: AuditTask[] = [];
      let fetchCompleted = false;

      const drainQueueIfPausing = async (): Promise<boolean> => {
        if (!(await this.shouldStopAuditJob(jobId))) return false;
        queue.length = 0;
        fetchCompleted = true;
        return true;
      };

      const getNextTask = async (): Promise<AuditTask | null> => {
        while (queue.length === 0) {
          if (fetchCompleted) return null;
          if (await this.shouldStopAuditJob(jobId)) return null;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return queue.shift() || null;
      };

      let skippedAlready = 0;
      let pausedDuringFetch = false;
      const rangeLabel =
        auditDateFrom === auditDateTo
          ? auditDateFrom
          : `${auditDateFrom} → ${auditDateTo}`;

      const inMemorySummary: Record<string, any> = {
        phase: 'fetch',
        auditDate: auditDateFrom,
        auditDateFrom,
        auditDateTo,
        pageId: pageIdTrimmed || null,
        scanAllPages,
        maxConversations: cap > 0 ? cap : null,
        remainingCap: cap > 0 ? cap : null,
        alreadyAudited: scanAllPages ? 0 : this.countAuditedForPage(auditedKeys, pageIdTrimmed || ''),
        fetched: 0,
        scanned: 0,
        pagesTotal: pages.length,
        pagesProcessed: 0,
        skippedAlready,
        force,
        processed: 0,
        audited: 0,
        errors: 0,
        avgScore: 0,
      };

      const reportProgressDb = async (patch: Record<string, unknown>) => {
        Object.assign(inMemorySummary, patch);
        const jsonSummary = JSON.stringify(inMemorySummary);
        try {
          await this.prisma.$executeRaw`
            UPDATE cskh_job_runs
            SET summary = COALESCE(summary, '{}'::jsonb) || CAST(${jsonSummary} AS jsonb)
            WHERE id = CAST(${jobId} AS uuid) AND status = 'running'
          `;
        } catch (err) {
          this.logger.error(`Lỗi cập nhật tiến độ job ${jobId}: ${(err as Error).message}`);
        }
      };

      // Initial progress write
      await reportProgressDb({});

      let pagesFetchDone = 0;
      let lastFetchProgressMs = 0;

      const reportFetchProgress = async (
        patch: Record<string, unknown>,
        force = false,
      ) => {
        const now = Date.now();
        if (!force && now - lastFetchProgressMs < 2500) return;
        lastFetchProgressMs = now;
        await reportProgressDb(patch);
      };

      let audited = 0;
      let errors = 0;
      let processed = 0;
      const scores: number[] = [];
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let totalTokens = 0;
      let tokenModel = 'deepseek-chat';

      const inboxAdMaps = await this.loadInboxAdMaps(pageIds);
      this.aiService.resetAuditBatchCaches();

      const auditOne = async ({ config, conv }: AuditTask) => {
        if (await this.shouldStopAuditJob(jobId)) return;
        if (!(await this.waitForInboxUnlessAuditStopped(jobId))) return;
        if (await this.shouldStopAuditJob(jobId)) return;

        const pageName = config.pageName || 'Facebook Page';

        // Load messages just-in-time from local DB if empty (to optimize memory usage)
        if (this.auditSource === 'database' && (!conv.messages?.data || conv.messages.data.length === 0)) {
          const { end } = this.graph.vietnamDateRange(auditDateFrom, auditDateTo);
          const dbMessages = await this.prisma.cskhInboxMessage.findMany({
            where: {
              conversationId: (conv as any).dbConversationId || conv.id,
              sentAt: { lte: end },
            },
            orderBy: { sentAt: 'desc' },
            take: this.auditMsgLimit,
          });

          const participantPsid = this.graph.resolveParticipantPsid(conv.participants, config.pageId) || 'Customer';

          const fbMessages: FbMessage[] = dbMessages.map((dbMsg) => {
            const fromId = dbMsg.direction === 'outbound' ? config.pageId : participantPsid;
            const fromName = dbMsg.direction === 'outbound' ? 'Staff' : 'Customer';
            const attachments = dbMsg.attachmentUrl
              ? {
                  data: [
                    {
                      url: dbMsg.attachmentUrl,
                      type: dbMsg.messageType || 'text',
                    },
                  ],
                }
              : undefined;

            return {
              id: dbMsg.fbMessageId || dbMsg.id,
              message: dbMsg.text,
              created_time: dbMsg.sentAt.toISOString(),
              from: { id: fromId, name: fromName },
              attachments,
            };
          });

          conv.messages = { data: fbMessages };
        }

        const messages = this.graph.latestMessages(conv);
        const rangeMessages = this.graph.filterMessagesByDateRange(
          messages,
          auditDateFrom,
          auditDateTo,
        );
        const dayMessages = rangeMessages;
        const staffAbsent = !this.graph.hasStaffMessage(rangeMessages, config.pageId);
        const needsFollowUp = this.graph.needsFollowUpOnDay(rangeMessages, config.pageId);
        const noReplyForAi = staffAbsent;
        const transcript = this.graph.messagesToTranscript(rangeMessages, config.pageId);
        const customerName = this.graph.resolveCustomerName(
          conv.participants,
          config.pageId,
          messages,
          transcript,
        );
        const agentName = this.graph.resolveAgentName(
          messages,
          config.pageId,
          pageName,
          transcript,
        );
        const participantPsid = this.graph.resolveParticipantPsid(conv.participants, config.pageId);

        const inboxAd = participantPsid
          ? (inboxAdMaps.get(config.pageId)?.get(participantPsid) ?? null)
          : null;
        const graphAd = detectAdFromFbMessages(messages);
        const fromAd = Boolean(inboxAd?.fromAd || graphAd.fromAd);
        const adId = inboxAd?.adId ?? graphAd.adId ?? null;
        const adTitle = inboxAd?.adTitle ?? graphAd.adTitle ?? null;
        const referralSource = inboxAd?.referralSource ?? graphAd.referralSource ?? null;

        const fullTranscript: TranscriptLine[] =
          transcript.length > 0
            ? transcript
            : [{ sender: 'Customer', type: 'text', text: '(Không có tin nhắn)', timestamp: '' }];
        const aiTranscript = trimTranscriptForAi(fullTranscript, this.auditAiTranscriptMax);

        if (await this.shouldStopAuditJob(jobId)) return;

        const result = await this.aiService.auditChat({
          transcript: fullTranscript,
          aiTranscript,
          agentName,
          customerName,
          channel: 'Facebook Messenger',
          noReply: noReplyForAi,
          metadata: {
            jobRunId: jobId,
            conversationId: conv.id,
            pageId: config.pageId,
            pageName,
            participantPsid,
            auditDate: auditDateFrom,
            auditDateFrom,
            auditDateTo,
            auditDayMessageCount: dayMessages.length,
            transcriptMessageCount: rangeMessages.length,
            noReply: needsFollowUp || staffAbsent,
            staffAbsent,
            needsFollowUp,
            fromAd,
            adId,
            adTitle,
            referralSource,
          },
        });

        if (result && typeof result === 'object' && 'error' in result && result.error) {
          errors++;
        } else if (result && 'id' in result) {
          audited++;
          scores.push(Number((result as { score?: number }).score) || 0);
          const tu = (result as {
            tokenUsage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
              model?: string;
            };
          }).tokenUsage;
          if (tu) {
            totalPromptTokens += Number(tu.prompt_tokens) || 0;
            totalCompletionTokens += Number(tu.completion_tokens) || 0;
            totalTokens += Number(tu.total_tokens) || 0;
            if (tu.model) tokenModel = tu.model;
          }

          // Auto-link chạy nền — không chặn worker; bỏ qua hẳn khi đang tạm dừng.
          if (participantPsid && !(await this.shouldStopAuditJob(jobId))) {
            const tenantId = job?.tenantId || undefined;
            const latestMsgs = this.graph.latestMessages(conv);
            void this.inboxService
              .autoLinkAndSync(
                (result as { id: string }).id,
                conv,
                latestMsgs,
                config.pageId,
                config.pageAccessToken,
                customerName,
                tenantId,
              )
              .catch((err) => {
                this.logger.warn(`Auto link and sync inbox conversation failed: ${(err as Error).message}`);
              });
          }
        }

        processed++;
        const tokenUsageSummary = {
          model: tokenModel,
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens,
          perAuditAvg: processed > 0 ? Math.round(totalTokens / processed) : 0,
        };
        await reportProgressDb({
          phase: fetchCompleted ? 'audit' : 'fetch',
          total: fetchCompleted ? inMemorySummary.fetched : undefined,
          processed,
          audited,
          errors,
          avgScore: scores.length
            ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
            : 0,
          currentCustomer: customerName,
          tokenUsage: tokenUsageSummary,
        });
      };

      // Start the audit consumer workers in the background
      const workerPromises = Array.from({ length: this.auditConcurrency }, async () => {
        while (true) {
          if (await this.shouldStopAuditJob(jobId)) break;
          if (!(await this.waitForInboxUnlessAuditStopped(jobId))) break;
          const task = await getNextTask();
          if (!task) break;
          await auditOne(task);
          await new Promise<void>((r) => setImmediate(r));
        }
      });

      const pageScannedMap = new Map<string, number>();

      try {
        const { stoppedEarly: pausedDuringFetchPages } = await this.runWithConcurrencyStoppable(
          pages.map((config, pageIndex) => ({ config, pageIndex })),
          this.auditPageConcurrency,
          async ({ config, pageIndex }) => {
            if (await this.shouldAbortAuditFetch(jobId)) return;
            const pageName = config.pageName || config.pageId;
            let effectiveCapForPage = cap;
            if (!force && cap > 0) {
              const pageAudited = this.countAuditedForPage(auditedKeys, config.pageId);
              effectiveCapForPage = Math.max(0, cap - pageAudited);
              if (effectiveCapForPage === 0) {
                pagesFetchDone++;
                this.logger.log(
                  `Audit job ${jobId.slice(0, 8)}: Page ${pageName} — đã đủ ${cap} cuộc, bỏ qua`,
                );
                await reportFetchProgress(
                  { pagesProcessed: pagesFetchDone, currentPage: pageName },
                  true,
                );
                return;
              }
            }
            try {
              await reportFetchProgress({
                currentPage: pageName,
              });

              let skippedOnPage = 0;
              let pageMatchedCount = 0;
              let conversations: FbConversation[] = [];
              let usingDb = false;

              const onMatch = async (conv: FbConversation) => {
                if (await drainQueueIfPausing()) return;
                pageMatchedCount++;
                queue.push({ config, conv });
                inMemorySummary.fetched = (inMemorySummary.fetched || 0) + 1;
                await reportFetchProgress({
                  fetched: inMemorySummary.fetched,
                });
              };

              if (this.auditSource === 'database') {
                this.logger.log(`[CskhService] Thử nghiệm quét từ database cục bộ cho Page ${pageName}...`);
                conversations = await this.fetchConversationsForAuditFromDb(
                  config.pageId,
                  auditDateFrom,
                  auditDateTo,
                  this.auditMsgLimit,
                  async (scanned, matchedOnPage) => {
                    pageScannedMap.set(config.pageId, scanned);
                    const totalScanned = Array.from(pageScannedMap.values()).reduce((a, b) => a + b, 0);
                    await reportFetchProgress({
                      scanned: totalScanned,
                      currentPage: pageName,
                    });
                  },
                  (conv) => {
                    if (this.isConversationAlreadyAudited(auditedKeys, config.pageId, conv)) {
                      skippedOnPage++;
                      return 'exclude';
                    }
                    return 'include';
                  },
                  effectiveCapForPage > 0 ? effectiveCapForPage : 0,
                  onMatch,
                  () => this.shouldAbortAuditFetch(jobId),
                );
                if (conversations.length > 0) {
                  usingDb = true;
                } else {
                  this.logger.warn(
                    `[CskhService] Không tìm thấy cuộc hội thoại nào trong database cho Page ${pageName} trong khoảng ${rangeLabel}. ` +
                      `Tự động fallback sang quét trực tiếp từ Facebook API...`,
                  );
                }
              }

              if (!usingDb) {
                const fetchConcurrency = this.graphCoordinator.auditFetchConcurrency(
                  this.auditFetchConcurrency,
                );
                conversations = await this.graph.fetchConversationsForAuditByDate(
                  config.pageId,
                  config.pageAccessToken,
                  auditDateFrom,
                  auditDateTo,
                  this.auditMsgLimit,
                  async (scanned, matchedOnPage) => {
                    pageScannedMap.set(config.pageId, scanned);
                    const totalScanned = Array.from(pageScannedMap.values()).reduce((a, b) => a + b, 0);
                    await reportFetchProgress({
                      scanned: totalScanned,
                      currentPage: pageName,
                    });
                  },
                  fetchConcurrency,
                  () => this.shouldAbortAuditFetch(jobId),
                  (conv) => {
                    if (this.isConversationAlreadyAudited(auditedKeys, config.pageId, conv)) {
                      skippedOnPage++;
                      return 'exclude';
                    }
                    return 'include';
                  },
                  effectiveCapForPage > 0 ? effectiveCapForPage : 0,
                  onMatch,
                );
              }

              pagesFetchDone++;
              skippedAlready += skippedOnPage;

              this.logger.log(
                `Audit job ${jobId.slice(0, 8)}: Page ${pageName} — ${rangeLabel}: chấm ${pageMatchedCount} cuộc mới` +
                  (cap > 0 ? ` (giới hạn ${cap})` : '') +
                  `, bỏ qua ${skippedOnPage} đã chấm`,
              );

              await reportFetchProgress(
                {
                  pagesProcessed: pagesFetchDone,
                  currentPage: pageName,
                  skippedAlready,
                },
                true,
              );
            } catch (err) {
              this.logger.error(`Lỗi khi quét page ${pageName} (${config.pageId}): ${(err as Error).message}`);
              // Vẫn tăng pagesProcessed để thanh tiến độ không bị kẹt
              pagesFetchDone++;
              await reportFetchProgress(
                {
                  pagesProcessed: pagesFetchDone,
                  currentPage: pageName,
                  skippedAlready,
                },
                true,
              );
            }
          },
          () => this.shouldAbortAuditFetch(jobId),
        );
        pausedDuringFetch = pausedDuringFetchPages;
      } finally {
        fetchCompleted = true;
        if (await this.shouldStopAuditJob(jobId)) {
          await drainQueueIfPausing();
        }
      }

      // Wait for in-flight chấm điểm (tối đa auditConcurrency), không lấy thêm từ queue.
      await Promise.all(workerPromises);

      if (await this.isAuditJobCancelled(jobId)) {
        this.logger.log(`Audit job ${jobId.slice(0, 8)}: đã hủy`);
        return;
      }

      // Fetch is done, all workers done. Check if we fetched anything.
      if (!inMemorySummary.fetched) {
        if (skippedAlready > 0) {
          if (await this.isAuditJobCancelled(jobId)) return;
          await this.finishJob(jobId, 'done', {
            auditDate: auditDateFrom,
            auditDateFrom,
            auditDateTo,
            skippedAlready,
            allAlreadyAudited: true,
            pageCount: pages.length,
          });
          return;
        }
        if (pausedDuringFetch) {
          if (await this.isAuditJobCancelled(jobId)) return;
          await drainQueueIfPausing();
          await this.finishJob(jobId, 'paused', {
            auditDate: auditDateFrom,
            auditDateFrom,
            auditDateTo,
            paused: true,
            partial: true,
            audited: 0,
            processed: 0,
            skippedAlready,
            pageCount: pages.length,
          });
          return;
        }
        throw new BadRequestException(
          `Không có hội thoại nào trong khoảng ${rangeLabel}`,
        );
      }

      const pausedDuringAudit = processed < inMemorySummary.fetched && (await this.shouldStopAuditJob(jobId));
      const paused = pausedDuringFetch || pausedDuringAudit;
      if (await this.isAuditJobCancelled(jobId)) return;

      const avgScore = scores.length
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : 0;

      await this.finishJob(jobId, paused ? 'paused' : 'done', {
        audited,
        errors,
        avgScore,
        pageCount: pages.length,
        total: inMemorySummary.fetched,
        processed,
        auditDate: auditDateFrom,
        auditDateFrom,
        auditDateTo,
        skippedAlready,
        paused,
        partial: paused,
        remaining: paused ? Math.max(0, inMemorySummary.fetched - processed) : 0,
        tokenUsage: {
          model: tokenModel,
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens,
          perAuditAvg: processed > 0 ? Math.round(totalTokens / processed) : 0,
        },
      });
      if (paused) {
        this.logger.log(
          `Audit job ${jobId.slice(0, 8)}: TẠM DỪNG — đã chấm ${processed}/${inMemorySummary.fetched} hội thoại`,
        );
      }
    } catch (e) {
      if (await this.isAuditJobCancelled(jobId)) {
        this.logger.log(`Audit job ${jobId.slice(0, 8)}: đã hủy (bỏ qua lỗi hậu kỳ)`);
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      await this.finishJob(jobId, 'failed', undefined, msg);
      this.logger.error(`Audit job ${jobId} failed: ${msg}`);
    }
  }

  getDeepSeekBalance() {
    return this.aiService.getDeepSeekBalance();
  }

  /** Token tổng job audit gần nhất (hoặc job đang chạy) — cho stat header FE. */
  async getAuditTokenStats() {
    const running = await this.findRunningJob('audit');
    if (running) {
      const summary = (running.summary as Record<string, unknown> | null) ?? {};
      const tokenUsage = summary.tokenUsage ?? null;
      return {
        source: 'running' as const,
        jobId: running.id,
        finishedAt: running.finishedAt,
        tokenUsage,
      };
    }

    const lastDone = await this.prisma.cskhJobRun.findFirst({
      where: { type: 'audit', status: 'done' },
      orderBy: { finishedAt: 'desc' },
    });
    if (!lastDone) {
      return { source: 'none' as const, jobId: null, finishedAt: null, tokenUsage: null };
    }
    const summary = (lastDone.summary as Record<string, unknown> | null) ?? {};
    return {
      source: 'lastJob' as const,
      jobId: lastDone.id,
      finishedAt: lastDone.finishedAt,
      tokenUsage: summary.tokenUsage ?? null,
    };
  }

  async listAudits(
    params: {
      pageId?: string;
      jobRunId?: string;
      auditDate?: string;
      auditDateFrom?: string;
      auditDateTo?: string;
      limit?: number;
    },
    tenantId?: string,
  ) {
    const limit = Math.min(params.limit ?? 100, 2000);
    if (params.jobRunId) {
      return this.listAuditsByJobRunId(params.jobRunId, limit, tenantId);
    }

    const auditDateFrom = (params.auditDateFrom || params.auditDate || '').trim();
    const auditDateTo = (params.auditDateTo || params.auditDateFrom || params.auditDate || '').trim();
    const pageId = params.pageId?.trim();

    if (auditDateFrom && auditDateTo) {
      type Row = {
        id: string;
        agentName: string | null;
        customerName: string | null;
        channel: string | null;
        score: number;
        feedback: string | null;
        transcript: unknown;
        metadata: unknown;
        createdAt: Date;
      };
      const rows = pageId
        ? await this.prisma.$queryRaw<Row[]>`
            SELECT id, agent_name AS "agentName", customer_name AS "customerName",
              channel, score, feedback, transcript, metadata, created_at AS "createdAt"
            FROM chat_audits
            WHERE metadata->>'pageId' = ${pageId}
              AND (
                (metadata->>'auditDateFrom' = ${auditDateFrom} AND metadata->>'auditDateTo' = ${auditDateTo})
                OR (
                  ${auditDateFrom} = ${auditDateTo}
                  AND metadata->>'auditDate' = ${auditDateFrom}
                  AND COALESCE(metadata->>'auditDateFrom', '') = ''
                )
              )
              AND (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
            ORDER BY created_at DESC
            LIMIT ${limit}
          `
        : await this.prisma.$queryRaw<Row[]>`
            SELECT id, agent_name AS "agentName", customer_name AS "customerName",
              channel, score, feedback, transcript, metadata, created_at AS "createdAt"
            FROM chat_audits
            WHERE (
                (metadata->>'auditDateFrom' = ${auditDateFrom} AND metadata->>'auditDateTo' = ${auditDateTo})
                OR (
                  ${auditDateFrom} = ${auditDateTo}
                  AND metadata->>'auditDate' = ${auditDateFrom}
                  AND COALESCE(metadata->>'auditDateFrom', '') = ''
                )
              )
              AND (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
      return this.attachAuditInboxContext(rows);
    }

    const filters = [
      ...(pageId ? [{ metadata: { path: ['pageId'], equals: pageId } }] : []),
      ...(tenantId ? [{ tenantId }] : []),
    ];

    const rows = await this.prisma.chatAudit.findMany({
      where: filters.length ? { AND: filters } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        agentName: true,
        customerName: true,
        channel: true,
        score: true,
        feedback: true,
        transcript: true,
        metadata: true,
        createdAt: true,
      },
    });
    return this.attachAuditInboxContext(rows);
  }

  /** Thống kê nhanh theo khoảng ngày chấm điểm — không tải transcript. */
  async getAuditDayStats(auditDateFrom: string, auditDateTo?: string, pageId?: string, tenantId?: string) {
    const from = auditDateFrom.trim();
    const to = (auditDateTo?.trim() || from).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new BadRequestException('Ngày không hợp lệ (YYYY-MM-DD)');
    }
    const pid = pageId?.trim();

    type StatsRow = {
      total: bigint;
      passed: bigint;
      failed: bigint;
      from_ad: bigint;
    };

    const rows = pid
      ? await this.prisma.$queryRaw<StatsRow[]>`
          SELECT
            COUNT(*)::bigint AS total,
            COUNT(*) FILTER (WHERE score >= 70)::bigint AS passed,
            COUNT(*) FILTER (WHERE score < 70)::bigint AS failed,
            COUNT(*) FILTER (WHERE COALESCE(metadata->>'fromAd', 'false') = 'true')::bigint AS from_ad
          FROM chat_audits
          WHERE metadata->>'pageId' = ${pid}
            AND (
              (metadata->>'auditDateFrom' = ${from} AND metadata->>'auditDateTo' = ${to})
              OR (
                ${from} = ${to}
                AND metadata->>'auditDate' = ${from}
                AND COALESCE(metadata->>'auditDateFrom', '') = ''
              )
            )
            AND (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
        `
      : await this.prisma.$queryRaw<StatsRow[]>`
          SELECT
            COUNT(*)::bigint AS total,
            COUNT(*) FILTER (WHERE score >= 70)::bigint AS passed,
            COUNT(*) FILTER (WHERE score < 70)::bigint AS failed,
            COUNT(*) FILTER (WHERE COALESCE(metadata->>'fromAd', 'false') = 'true')::bigint AS from_ad
          FROM chat_audits
          WHERE (
              (metadata->>'auditDateFrom' = ${from} AND metadata->>'auditDateTo' = ${to})
              OR (
                ${from} = ${to}
                AND metadata->>'auditDate' = ${from}
                AND COALESCE(metadata->>'auditDateFrom', '') = ''
              )
            )
            AND (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
        `;

    const row = rows[0];
    return {
      auditDate: from,
      auditDateFrom: from,
      auditDateTo: to,
      pageId: pid ?? null,
      total: Number(row?.total ?? 0),
      passed: Number(row?.passed ?? 0),
      failed: Number(row?.failed ?? 0),
      fromAd: Number(row?.from_ad ?? 0),
    };
  }

  /** So sánh điểm NV / team (cùng page) / trung bình ngày — tính từ DB. */
  async getAuditComparisonStats(auditDate: string, auditId: string, tenantId?: string) {
    const day = auditDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new BadRequestException('Ngày audit không hợp lệ (YYYY-MM-DD)');
    }

    const audit = await this.prisma.chatAudit.findFirst({
      where: tenantId ? { id: auditId, tenantId } : { id: auditId },
      select: { id: true, score: true, agentName: true, metadata: true },
    });
    if (!audit) throw new NotFoundException('Không tìm thấy audit hoặc không có quyền');

    const meta = (audit.metadata as Record<string, unknown> | null) ?? {};
    const auditDay = String(meta.auditDate ?? '');
    if (auditDay && auditDay !== day) {
      throw new BadRequestException('auditDate không khớp với audit được chọn');
    }

    const pageName = typeof meta.pageName === 'string' ? meta.pageName : null;
    const agentName = audit.agentName?.trim() || null;

    type ScoreRow = { score: number; agent_name: string | null; page_name: string | null };
    const rows = await this.prisma.$queryRaw<ScoreRow[]>`
      SELECT
        score,
        agent_name,
        metadata->>'pageName' AS page_name
      FROM chat_audits
      WHERE metadata->>'auditDate' = ${day}
        AND (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
    `;

    const scores = rows.map((r) => r.score);
    const overall =
      scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : audit.score;

    const staffRows =
      agentName && agentName !== 'Nhân viên'
        ? rows.filter((r) => (r.agent_name ?? '').trim() === agentName)
        : [audit];
    const staff =
      staffRows.length > 0
        ? Math.round(staffRows.reduce((a, r) => a + r.score, 0) / staffRows.length)
        : audit.score;

    const teamRows = pageName
      ? rows.filter((r) => (r.page_name ?? '').trim() === pageName)
      : rows;
    const team =
      teamRows.length > 0
        ? Math.round(teamRows.reduce((a, r) => a + r.score, 0) / teamRows.length)
        : overall;

    return {
      auditDate: day,
      auditId: audit.id,
      staff,
      team,
      overall,
      staffSampleSize: staffRows.length,
      teamSampleSize: teamRows.length,
      daySampleSize: scores.length,
    };
  }

  /** Điểm chất lượng cùng hội thoại qua các ngày audit (nếu được quét nhiều lần). */
  async getAuditScoreHistory(auditId: string, tenantId?: string) {
    const audit = await this.prisma.chatAudit.findFirst({
      where: tenantId ? { id: auditId, tenantId } : { id: auditId },
      select: { id: true, score: true, metadata: true, createdAt: true },
    });
    if (!audit) throw new NotFoundException('Không tìm thấy audit hoặc không có quyền');

    const meta = (audit.metadata as Record<string, unknown> | null) ?? {};
    const pageId = typeof meta.pageId === 'string' ? meta.pageId.trim() : '';
    const conversationId =
      typeof meta.conversationId === 'string' ? meta.conversationId.trim() : '';
    const participantPsid =
      typeof meta.participantPsid === 'string' ? meta.participantPsid.trim() : '';

    type HistoryRow = {
      id: string;
      score: number;
      audit_date: string | null;
      created_at: Date;
    };

    let rows: HistoryRow[] = [];
    if (pageId && (conversationId || participantPsid)) {
      rows = await this.prisma.$queryRaw<HistoryRow[]>`
        SELECT
          id,
          score,
          metadata->>'auditDate' AS audit_date,
          created_at
        FROM chat_audits
        WHERE metadata->>'pageId' = ${pageId}
          AND (
            (${conversationId} <> '' AND metadata->>'conversationId' = ${conversationId})
            OR (${participantPsid} <> '' AND metadata->>'participantPsid' = ${participantPsid})
          )
          AND (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
        ORDER BY COALESCE(metadata->>'auditDate', '') ASC, created_at ASC
      `;
    }

    if (!rows.length) {
      const day = typeof meta.auditDate === 'string' ? meta.auditDate : '';
      return {
        auditId: audit.id,
        points: [
          {
            auditId: audit.id,
            auditDate: day || audit.createdAt.toISOString().slice(0, 10),
            score: audit.score,
            label: day || 'Hiện tại',
          },
        ],
      };
    }

    const byDay = new Map<string, { auditId: string; auditDate: string; score: number }>();
    for (const row of rows) {
      const auditDate =
        row.audit_date?.trim() || row.created_at.toISOString().slice(0, 10);
      byDay.set(auditDate, {
        auditId: row.id,
        auditDate,
        score: row.score,
      });
    }

    const points = [...byDay.values()].map((p) => ({
      ...p,
      label: p.auditDate,
    }));

    return { auditId: audit.id, points };
  }

  private customerPictureFromMetadata(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== 'object') return null;
    const url = (metadata as { customerPictureUrl?: string }).customerPictureUrl;
    return typeof url === 'string' && url.startsWith('http') ? url : null;
  }

  private auditAdFromMetadata(metadata: unknown): {
    fromAd: boolean;
    adId: string | null;
    adTitle: string | null;
    referralSource: string | null;
  } {
    if (!metadata || typeof metadata !== 'object') {
      return { fromAd: false, adId: null, adTitle: null, referralSource: null };
    }
    const m = metadata as {
      fromAd?: boolean;
      adId?: string | null;
      adTitle?: string | null;
      referralSource?: string | null;
    };
    return {
      fromAd: Boolean(m.fromAd),
      adId: typeof m.adId === 'string' ? m.adId : null,
      adTitle: typeof m.adTitle === 'string' ? m.adTitle : null,
      referralSource: typeof m.referralSource === 'string' ? m.referralSource : null,
    };
  }

  private async attachAuditInboxContext<
    T extends { metadata: unknown; customerName: string | null },
  >(rows: T[]) {
    const needInbox: Array<{ pageId: string; psid: string; index: number }> = [];
    const pictures: Array<string | null> = rows.map((row, index) => {
      const fromMeta = this.customerPictureFromMetadata(row.metadata);
      if (fromMeta) return fromMeta;
      const meta = row.metadata as { pageId?: string; participantPsid?: string } | null;
      if (meta?.pageId && meta?.participantPsid) {
        needInbox.push({ pageId: meta.pageId, psid: meta.participantPsid, index });
      }
      return null;
    });

    const adContext: Array<{
      fromAd: boolean;
      adId: string | null;
      adTitle: string | null;
      referralSource: string | null;
    }> = rows.map((row) => this.auditAdFromMetadata(row.metadata));

    if (needInbox.length) {
      type InboxContextRow = {
        pageId: string;
        participantPsid: string;
        customerPictureUrl: string | null;
        fromAd: boolean;
        adId: string | null;
        adTitle: string | null;
        referralSource: string | null;
      };
      const inboxRows: InboxContextRow[] = await this.prisma.cskhInboxConversation.findMany({
        where: {
          OR: needInbox.map((k) => ({
            pageId: k.pageId,
            participantPsid: k.psid,
          })),
        },
        select: {
          pageId: true,
          participantPsid: true,
          customerPictureUrl: true,
          fromAd: true,
          adId: true,
          adTitle: true,
          referralSource: true,
        },
      });
      const inboxMap = new Map<string, InboxContextRow>(
        inboxRows.map((r) => [`${r.pageId}:${r.participantPsid}`, r]),
      );
      for (const k of needInbox) {
        const inbox = inboxMap.get(`${k.pageId}:${k.psid}`);
        if (!inbox) continue;
        const url = inbox.customerPictureUrl;
        if (typeof url === 'string' && url.startsWith('http')) {
          pictures[k.index] = url;
        }
        if (!adContext[k.index].fromAd && inbox.fromAd) {
          adContext[k.index] = {
            fromAd: true,
            adId: inbox.adId,
            adTitle: inbox.adTitle,
            referralSource: inbox.referralSource,
          };
        }
      }
    }

    return rows.map((row, index) => ({
      ...row,
      customerPictureUrl: pictures[index],
      fromAd: adContext[index].fromAd,
      adId: adContext[index].adId,
      adTitle: adContext[index].adTitle,
      referralSource: adContext[index].referralSource,
    }));
  }

  /** @deprecated alias — dùng attachAuditInboxContext */
  private async attachCustomerPictures<
    T extends { metadata: unknown; customerName: string | null },
  >(rows: T[]) {
    return this.attachAuditInboxContext(rows);
  }

  private async fetchAndCacheCustomerPicture(pageId: string, psid: string): Promise<string | null> {
    const config = await this.prisma.facebookCskhConfig.findUnique({ where: { pageId } });
    if (!config?.pageAccessToken) return null;
    const profile = await this.graph.getMessengerUserProfile(psid, config.pageAccessToken);
    if (!profile.pictureUrl?.startsWith('http')) return null;

    await this.prisma.cskhInboxConversation
      .updateMany({
        where: { pageId, participantPsid: psid },
        data: {
          customerPictureUrl: profile.pictureUrl,
          customerName: profile.name ?? undefined,
        },
      })
      .catch(() => undefined);

    return profile.pictureUrl;
  }

  /** Proxy media Facebook CDN — public (thẻ img/video không gửi JWT). */
  async proxyMediaUrl(rawUrl: string, res: Response) {
    let url = (rawUrl || '').trim();
    if (!url) {
      throw new BadRequestException(
        'Thiếu tham số url — URL phải encode đầy đủ (encodeURIComponent)',
      );
    }
    if (!isAllowedFacebookMediaUrl(url)) {
      throw new BadRequestException('URL media không hợp lệ');
    }
    if (url.startsWith('http://')) {
      url = `https://${url.slice('http://'.length)}`;
    }
    try {
      const upstream = await axios.get(url, {
        responseType: 'stream',
        timeout: 30000,
        maxRedirects: 5,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://www.facebook.com/',
        },
      });
      res.set('Cache-Control', 'public, max-age=3600');
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
      const contentType = upstream.headers['content-type'];
      res.set(
        'Content-Type',
        typeof contentType === 'string' ? contentType : 'application/octet-stream',
      );
      upstream.data.pipe(res);
    } catch (e) {
      this.logger.warn(`Failed to proxy media URL: ${(e as Error).message}. Redirecting to original URL.`);
      try {
        if (!res.headersSent) {
          res.redirect(url);
        }
      } catch (redirectErr) {
        this.logger.error(`Failed to redirect: ${(redirectErr as Error).message}`);
        if (!res.headersSent) {
          res.status(404).send('Media not found');
        }
      }
    }
  }

  /** @deprecated Dùng proxyMediaUrl */
  async proxyAvatarUrl(rawUrl: string, res: Response) {
    return this.proxyMediaUrl(rawUrl, res);
  }

  /** Avatar Page — fetch Graph theo pageId rồi stream (public, không JWT). */
  async streamPageAvatar(pageId: string, res: Response) {
    const pid = (pageId || '').trim();
    if (!pid || !/^\d+$/.test(pid)) {
      throw new BadRequestException('pageId không hợp lệ');
    }

    const config = await this.prisma.facebookCskhConfig.findUnique({ where: { pageId: pid } });
    if (!config?.pageAccessToken) {
      throw new NotFoundException('Page chưa liên kết');
    }

    const pictureUrl = await this.graph.getPagePictureUrl(pid, config.pageAccessToken);
    if (!pictureUrl?.startsWith('http')) {
      // Trả về ảnh SVG đại diện mặc định cho Page thay vì báo lỗi 404 để làm sạch log
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
          <rect width="100" height="100" fill="#EEF2FF"/>
          <rect x="25" y="25" width="50" height="50" rx="10" fill="#6366F1"/>
          <text x="50" y="58" font-family="sans-serif" font-size="24" font-weight="bold" fill="#FFFFFF" text-anchor="middle">P</text>
        </svg>
      `.trim();
      res.type('image/svg+xml');
      return res.send(svg);
    }

    const prev = (config.metadata as Record<string, unknown>) || {};
    await this.prisma.facebookCskhConfig
      .update({
        where: { pageId: pid },
        data: {
          metadata: { ...prev, pictureUrl } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    return this.proxyMediaUrl(pictureUrl, res);
  }

  /** Avatar khách — fetch mới từ Graph rồi stream (public, không JWT). */
  async streamCustomerAvatar(pageId: string, psid: string, res: Response) {
    const pid = (pageId || '').trim();
    const uid = (psid || '').trim();
    if (!pid || !uid) throw new BadRequestException('Thiếu pageId hoặc psid');

    const config = await this.prisma.facebookCskhConfig.findUnique({ where: { pageId: pid } });
    if (!config?.pageAccessToken) throw new NotFoundException('Page chưa liên kết');

    let profile: { name: string | null; pictureUrl: string | null };
    try {
      profile = await this.graph.getMessengerUserProfile(uid, config.pageAccessToken);
    } catch {
      profile = { name: null, pictureUrl: null };
    }
    if (!profile.pictureUrl?.startsWith('http')) {
      // Trả về ảnh SVG đại diện mặc định cho Khách hàng để làm sạch log và nâng cao trải nghiệm người dùng
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
          <rect width="100" height="100" fill="#E2E8F0"/>
          <circle cx="50" cy="35" r="20" fill="#94A3B8"/>
          <path d="M15 85 C15 65, 35 60, 50 60 C65 60, 85 65, 85 85" fill="#94A3B8"/>
        </svg>
      `.trim();
      res.type('image/svg+xml');
      return res.send(svg);
    }

    await this.prisma.cskhInboxConversation
      .updateMany({
        where: { pageId: pid, participantPsid: uid },
        data: {
          customerPictureUrl: profile.pictureUrl,
          customerName: profile.name ?? undefined,
        },
      })
      .catch(() => undefined);

    return this.proxyMediaUrl(profile.pictureUrl, res);
  }

  /** Lấy audit theo jobRunId — dùng raw SQL vì Prisma JSON path filter không ổn định. */
  private async listAuditsByJobRunId(jobRunId: string, limit: number, tenantId?: string) {
    type AuditRow = {
      id: string;
      agentName: string | null;
      customerName: string | null;
      channel: string | null;
      score: number;
      feedback: string | null;
      transcript: unknown;
      metadata: unknown;
      createdAt: Date;
    };
    const rows = await this.prisma.$queryRaw<AuditRow[]>`
      SELECT
        id,
        agent_name AS "agentName",
        customer_name AS "customerName",
        channel,
        score,
        feedback,
        transcript,
        metadata,
        created_at AS "createdAt"
      FROM chat_audits
      WHERE metadata->>'jobRunId' = ${jobRunId}
        AND (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return this.attachCustomerPictures(rows);
  }

  /** Một endpoint gộp: trạng thái job + kết quả audit từ DB (nguồn sự thật cho UI). */
  async getAuditProgress(jobId: string, tenantId?: string, opts?: { includeAudits?: boolean }) {
    const includeAudits = opts?.includeAudits !== false;
    let job = await this.prisma.cskhJobRun.findFirst({
      where: tenantId ? { id: jobId, tenantId } : { id: jobId },
    });
    if (!job) throw new NotFoundException('Job không tồn tại hoặc không có quyền');

    let auditCount = 0;
    let audits: Awaited<ReturnType<typeof this.listAuditsByJobRunId>> = [];
    if (includeAudits) {
      audits = await this.listAuditsByJobRunId(jobId, 500, tenantId);
      auditCount = audits.length;
    } else {
      const countRow = await this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        FROM chat_audits
        WHERE metadata->>'jobRunId' = ${jobId}
      `;
      auditCount = Number(countRow[0]?.count ?? 0);
    }

    if (await this.failGhostJobIfNeeded(job, auditCount)) {
      job = await this.prisma.cskhJobRun.findFirst({
        where: tenantId ? { id: jobId, tenantId } : { id: jobId },
      });
      if (!job) throw new NotFoundException('Job không tồn tại hoặc không có quyền');
      if (includeAudits && job.status !== 'running') {
        audits = await this.listAuditsByJobRunId(jobId, 500, tenantId);
        auditCount = audits.length;
      }
    } else if (includeAudits) {
      auditCount = audits.length;
    }

    const summary = (job.summary as Record<string, unknown> | null) ?? {};
    return {
      id: job.id,
      status: job.status,
      error: job.error ? toUserFacingError(job.error) : null,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      summary: {
        ...summary,
        auditCount,
      },
      audits: includeAudits ? audits : [],
    };
  }

  async subscribePageToWebhook(pageId: string, pageAccessToken: string) {
    try {
      const url = `${GRAPH_BASE}/${pageId}/subscribed_apps`;
      const res = await axios.post(
        url,
        null,
        {
          params: {
            subscribed_fields: 'messages,message_echoes,messaging_postbacks,messaging_optins,message_deliveries,message_reads,messaging_referrals',
            access_token: pageAccessToken,
          },
          timeout: 10000,
        }
      );
      this.logger.log(`Subscribed page ${pageId} to webhook successfully: ${JSON.stringify(res.data)}`);
      return res.data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      this.logger.error(`Failed to subscribe page ${pageId} to webhook: ${msg}`);
      if (axios.isAxiosError(e) && e.response) {
        this.logger.error(`Facebook error response for page ${pageId}: ${JSON.stringify(e.response.data)}`);
      }
      throw e;
    }
  }

  async getDashboardStats(tenantId?: string) {
    const cacheKey = tenantId ?? '__all__';
    const cached = this.dashboardStatsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.dashboardStatsTtlMs) {
      return cached.data;
    }

    const whereTenant = tenantId ? { tenantId } : {};

    const [totalPages, enabledPages, totalAudits, avgScoreResult, recentAudits, latestJobs] =
      await Promise.all([
        this.prisma.facebookCskhConfig.count({ where: whereTenant }),
        this.prisma.facebookCskhConfig.count({ where: { ...whereTenant, enabled: true } }),
        this.prisma.chatAudit.count({ where: whereTenant }),
        this.prisma.chatAudit.aggregate({
          where: whereTenant,
          _avg: { score: true },
        }),
        this.prisma.chatAudit.findMany({
          where: whereTenant,
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            agentName: true,
            customerName: true,
            channel: true,
            score: true,
            createdAt: true,
          },
        }),
        this.prisma.cskhJobRun.findMany({
          where: whereTenant,
          orderBy: { startedAt: 'desc' },
          take: 5,
          select: {
            id: true,
            type: true,
            status: true,
            startedAt: true,
            finishedAt: true,
          },
        }),
      ]);

    const avgScore = avgScoreResult._avg.score ? Math.round(avgScoreResult._avg.score) : 0;

    const result = {
      totalPages,
      enabledPages,
      totalAudits,
      avgScore,
      recentAudits,
      latestJobs,
    };

    this.dashboardStatsCache.set(cacheKey, { at: Date.now(), data: result });
    return result;
  }

  /** COUNT hội thoại/tin nhắn — cache lâu, tách khỏi stats nhanh để Tổng quan load ngay. */
  async getDashboardHeavyStats(tenantId?: string) {
    const cacheKey = tenantId ?? '__all__';
    const cached = this.dashboardHeavyCountsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.dashboardHeavyCountsTtlMs) {
      return cached.data;
    }

    const whereTenant = tenantId ? { tenantId } : {};
    const [totalConversations, totalMessages] = await Promise.all([
      this.prisma.cskhInboxConversation.count({ where: whereTenant }),
      this.prisma.cskhInboxMessage.count({ where: whereTenant }),
    ]);

    const result = { totalConversations, totalMessages };
    this.dashboardHeavyCountsCache.set(cacheKey, { at: Date.now(), data: result });
    return result;
  }
}
