import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  OnApplicationBootstrap,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { CskhInboxService } from '../inbox/cskh-inbox.service';
import { CskhService } from '../cskh.service';
import { getCskhRunMode, isCskhWorkerProcess } from '../cskh-run-mode';
import { CskhRedisSignalsService } from './cskh-redis-signals.service';
import {
  isRedisCircuitOpen,
  isRedisQuotaError,
  onRedisQuotaTripped,
} from './cskh-redis-circuit';

export type AuditQueuePayload = {
  jobId: string;
  options: {
    auditDate?: string;
    auditDateFrom?: string;
    auditDateTo?: string;
    maxConversations?: number;
    force?: boolean;
    pageId?: string;
  };
};

const AUDIT_HEARTBEAT_KEY = 'cskh:worker:audit:heartbeat';
const WEBHOOK_MESSAGING_QUEUE = 'cskh:webhook:messaging';
const INTENT_QUEUE = 'cskh:intent_queue';
const AUDIT_QUEUE = 'cskh:audit_queue';
const BACKFILL_QUEUE = 'cskh:backfill_queue';
const BRPOP_TIMEOUT_SEC = 30;

export type BackfillQueuePayload = {
  jobId: string;
};

export type WebhookMessagingQueuePayload = {
  pageId: string;
  event: Record<string, unknown>;
};

type IntentQueuePayload = { conversationId: string; tenantId?: string };

@Injectable()
export class RedisQueueService implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap {
  private readonly logger = new Logger(RedisQueueService.name);
  private redisClient: Redis;
  /** Một connection blocking duy nhất — BRPOP nhiều queue (tiết kiệm Upstash requests). */
  private blockingConsumer: Redis | null = null;
  private running = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private intentMemCache = new Map<string, { raw: string; exp: number }>();
  private lastHeartbeatRedisWrite = 0;
  private webhookDepthCache = { at: 0, depth: 0 };

  constructor(
    private readonly configService: ConfigService,
    private readonly redisSignals: CskhRedisSignalsService,
    @Inject(forwardRef(() => CskhInboxService))
    private readonly inboxService: CskhInboxService,
    @Inject(forwardRef(() => CskhService))
    private readonly cskhService: CskhService,
  ) {}

  onModuleInit() {
    const cleanValue = (val: unknown) => {
      if (typeof val !== 'string') return val;
      return val.trim().replace(/^['"]|['"]$/g, '');
    };

    const redisUrl = cleanValue(this.configService.get<string>('REDIS_URL'));
    const host = cleanValue(this.configService.get<string>('REDIS_HOST')) || 'localhost';
    const port = Number(this.configService.get<number>('REDIS_PORT')) || 6379;
    const password =
      cleanValue(
        this.configService.get<string>('REDIS_PASSWORD') ||
          this.configService.get<string>('REDISPASSWORD'),
      ) || undefined;

    if (redisUrl) {
      this.logger.log('Initializing Redis (single client + optional blocking consumer)...');
      this.redisClient = new Redis(redisUrl as string);
      if (isCskhWorkerProcess()) {
        this.blockingConsumer = new Redis(redisUrl as string);
      }
    } else {
      this.logger.log(`Initializing Redis to ${host}:${port}...`);
      const redisConfig = {
        host: host as string,
        port,
        password: password as string | undefined,
      };
      this.redisClient = new Redis(redisConfig);
      if (isCskhWorkerProcess()) {
        this.blockingConsumer = new Redis(redisConfig);
      }
    }

    this.logger.log(`CSKH_RUN_MODE=${getCskhRunMode()}`);
  }

  onApplicationBootstrap() {
    this.running = true;
    const mode = getCskhRunMode();
    this.logger.log(`Starting queue workers (mode=${mode})`);

    if (isCskhWorkerProcess()) {
      void this.runUnifiedQueueWorker();
      this.heartbeatTimer = setInterval(() => {
        void this.touchAuditWorkerHeartbeat();
      }, 60_000);
      void this.touchAuditWorkerHeartbeat();
    } else {
      this.logger.log(
        'Queue consumers OFF on API process — webhook/audit/intent chạy trên worker (CSKH_RUN_MODE=worker)',
      );
    }
  }

  async onModuleDestroy() {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.logger.log('Closing Redis connections...');
    await Promise.all([
      this.redisClient?.quit(),
      this.blockingConsumer?.quit(),
    ]).catch((e) => {
      this.logger.warn(`Error closing Redis connections: ${(e as Error).message}`);
    });
  }

  get client(): Redis {
    return this.redisClient;
  }

  private canUseRedis(): boolean {
    return !isRedisCircuitOpen();
  }

  private handleRedisError(e: unknown): void {
    if (isRedisQuotaError(e)) onRedisQuotaTripped(this.logger);
  }

  async markInboxActivity(ttlSeconds = 90): Promise<void> {
    return this.redisSignals.markInboxActivity(ttlSeconds);
  }

  async isInboxHot(): Promise<boolean> {
    return this.redisSignals.isInboxHot();
  }

  async markInboxSyncActive(ttlSeconds = 120): Promise<void> {
    return this.redisSignals.markInboxSyncActive(ttlSeconds);
  }

  async isInboxSyncActive(): Promise<boolean> {
    return this.redisSignals.isInboxSyncActive();
  }

  async clearInboxSyncActive(): Promise<void> {
    return this.redisSignals.clearInboxSyncActive();
  }

  async shouldYieldGraphToInbox(): Promise<boolean> {
    return this.redisSignals.shouldYieldGraphToInbox();
  }

  async waitWhileInboxHot(maxWaitMs = 90_000): Promise<void> {
    return this.redisSignals.waitWhileInboxHot(maxWaitMs);
  }

  async touchAuditWorkerHeartbeat(): Promise<void> {
    if (!this.canUseRedis()) return;
    const now = Date.now();
    if (now - this.lastHeartbeatRedisWrite < 25_000) return;
    this.lastHeartbeatRedisWrite = now;
    try {
      await this.redisClient.set(AUDIT_HEARTBEAT_KEY, String(now), 'EX', 60);
    } catch (e) {
      this.handleRedisError(e);
    }
  }

  async isAuditWorkerAlive(): Promise<boolean> {
    if (!this.canUseRedis()) return isCskhWorkerProcess();
    try {
      return !!(await this.redisClient.get(AUDIT_HEARTBEAT_KEY));
    } catch (e) {
      this.handleRedisError(e);
      return false;
    }
  }

  async setAuditPauseRequested(jobId: string): Promise<void> {
    return this.redisSignals.setAuditPauseRequested(jobId);
  }

  async isAuditPauseRequested(jobId: string): Promise<boolean> {
    return this.redisSignals.isAuditPauseRequested(jobId);
  }

  async clearAuditPauseRequested(jobId: string): Promise<void> {
    return this.redisSignals.clearAuditPauseRequested(jobId);
  }

  async setBackfillPauseRequested(jobId: string): Promise<void> {
    return this.redisSignals.setBackfillPauseRequested(jobId);
  }

  async isBackfillPauseRequested(jobId: string): Promise<boolean> {
    return this.redisSignals.isBackfillPauseRequested(jobId);
  }

  async clearBackfillPauseRequested(jobId: string): Promise<void> {
    return this.redisSignals.clearBackfillPauseRequested(jobId);
  }

  async setBackfillCancelRequested(jobId: string): Promise<void> {
    return this.redisSignals.setBackfillCancelRequested(jobId);
  }

  async isBackfillCancelRequested(jobId: string): Promise<boolean> {
    return this.redisSignals.isBackfillCancelRequested(jobId);
  }

  async clearBackfillCancelRequested(jobId: string): Promise<void> {
    return this.redisSignals.clearBackfillCancelRequested(jobId);
  }

  async bumpPageStatsCache(tenantId?: string): Promise<void> {
    return this.redisSignals.bumpPageStatsCache(tenantId);
  }

  async getPageStatsCacheBustAt(tenantId?: string): Promise<number> {
    return this.redisSignals.getPageStatsCacheBustAt(tenantId);
  }

  async enqueueIntent(conversationId: string, tenantId?: string): Promise<void> {
    const payload = JSON.stringify({ conversationId, tenantId });
    if (!this.canUseRedis()) {
      void this.inboxService.analyzeAndBroadcastIntent(conversationId, tenantId).catch((err) => {
        this.logger.error(`Inline intent processing failed: ${(err as Error).message}`);
      });
      return;
    }
    try {
      await this.redisClient.lpush(INTENT_QUEUE, payload);
    } catch (e) {
      this.handleRedisError(e);
      this.logger.error(`Failed to enqueue intent: ${(e as Error).message}`);
      void this.inboxService.analyzeAndBroadcastIntent(conversationId, tenantId).catch((err) => {
        this.logger.error(`Fallback intent processing failed: ${(err as Error).message}`);
      });
    }
  }

  async getWebhookQueueDepth(): Promise<number> {
    if (Date.now() - this.webhookDepthCache.at < 20_000) {
      return this.webhookDepthCache.depth;
    }
    if (!this.canUseRedis()) return 0;
    try {
      const depth = (await this.redisClient.llen(WEBHOOK_MESSAGING_QUEUE)) ?? 0;
      this.webhookDepthCache = { at: Date.now(), depth };
      return depth;
    } catch (e) {
      this.handleRedisError(e);
      return 0;
    }
  }

  async enqueueWebhookMessaging(pageId: string, event: Record<string, unknown>): Promise<boolean> {
    if (!this.canUseRedis()) return false;
    try {
      const payload: WebhookMessagingQueuePayload = { pageId, event };
      await this.redisClient.lpush(WEBHOOK_MESSAGING_QUEUE, JSON.stringify(payload));
      return true;
    } catch (e) {
      this.handleRedisError(e);
      this.logger.error(`Failed to enqueue webhook messaging: ${(e as Error).message}`);
      return false;
    }
  }

  /** Worker duy nhất — BRPOP 4 queue, ưu tiên webhook trước backfill/audit. */
  private async runUnifiedQueueWorker() {
    if (!this.blockingConsumer) return;
    this.logger.log('Unified queue worker started (webhook + intent + backfill + audit).');
    while (this.running) {
      if (!this.canUseRedis()) {
        await new Promise((r) => setTimeout(r, 60_000));
        continue;
      }
      try {
        const result = await this.blockingConsumer.brpop(
          WEBHOOK_MESSAGING_QUEUE,
          INTENT_QUEUE,
          BACKFILL_QUEUE,
          AUDIT_QUEUE,
          BRPOP_TIMEOUT_SEC,
        );
        if (!result) continue;

        const [queue, raw] = result;
        if (queue === WEBHOOK_MESSAGING_QUEUE) {
          const payload = JSON.parse(raw) as WebhookMessagingQueuePayload;
          if (!payload?.pageId || !payload.event) continue;
          await this.inboxService.ingestMessagingEvent(
            payload.pageId,
            payload.event as Parameters<CskhInboxService['ingestMessagingEvent']>[1],
          );
        } else if (queue === INTENT_QUEUE) {
          const { conversationId, tenantId } = JSON.parse(raw) as IntentQueuePayload;
          await this.waitWhileInboxHot(30_000);
          await this.inboxService.analyzeAndBroadcastIntent(conversationId, tenantId);
        } else if (queue === BACKFILL_QUEUE) {
          const payload = JSON.parse(raw) as BackfillQueuePayload;
          if (!payload?.jobId) continue;
          this.logger.log(`Backfill Worker: job ${payload.jobId.slice(0, 8)}`);
          await this.inboxService.executeBackfillJob(payload.jobId);
          this.logger.log(`Backfill Worker: done ${payload.jobId.slice(0, 8)}`);
        } else if (queue === AUDIT_QUEUE) {
          const payload = JSON.parse(raw) as AuditQueuePayload;
          if (!payload?.jobId) continue;
          const jobRow = await this.cskhService.findJobStatus(payload.jobId);
          if (!jobRow || jobRow.status !== 'running') {
            this.logger.log(
              `Audit Worker: skip ${payload.jobId.slice(0, 8)} (status=${jobRow?.status ?? 'missing'})`,
            );
            continue;
          }
          this.logger.log(`Audit Worker: job ${payload.jobId.slice(0, 8)}`);
          await this.cskhService.runAuditJob(payload.jobId, payload.options ?? {});
          this.logger.log(`Audit Worker: done ${payload.jobId.slice(0, 8)}`);
        }
      } catch (e) {
        if (isRedisQuotaError(e)) {
          onRedisQuotaTripped(this.logger);
          await new Promise((r) => setTimeout(r, 60_000));
        } else {
          this.logger.error(`Unified queue worker error: ${(e as Error).message}`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
    this.logger.log('Unified queue worker stopped.');
  }

  /** Intent cache — memory-only (không dùng Redis, tiết kiệm Upstash). */
  async getIntentCache(key: string): Promise<any> {
    const mem = this.intentMemCache.get(key);
    if (!mem || mem.exp <= Date.now()) {
      if (mem) this.intentMemCache.delete(key);
      return null;
    }
    try {
      return JSON.parse(mem.raw);
    } catch {
      this.intentMemCache.delete(key);
      return null;
    }
  }

  async setIntentCache(key: string, data: any, ttlSeconds = 600): Promise<void> {
    this.intentMemCache.set(key, {
      raw: JSON.stringify(data),
      exp: Date.now() + ttlSeconds * 1000,
    });
    if (this.intentMemCache.size > 500) {
      const oldest = this.intentMemCache.keys().next().value;
      if (oldest) this.intentMemCache.delete(oldest);
    }
  }

  async enqueueAuditJob(payload: AuditQueuePayload): Promise<boolean> {
    if (!this.canUseRedis()) return false;
    try {
      await this.redisClient.lpush(AUDIT_QUEUE, JSON.stringify(payload));
      return true;
    } catch (e) {
      this.handleRedisError(e);
      this.logger.error(`Failed to enqueue audit job: ${(e as Error).message}`);
      return false;
    }
  }

  async enqueueBackfillJob(payload: BackfillQueuePayload): Promise<boolean> {
    if (!this.canUseRedis()) return false;
    try {
      await this.redisClient.lpush(BACKFILL_QUEUE, JSON.stringify(payload));
      return true;
    } catch (e) {
      this.handleRedisError(e);
      this.logger.error(`Failed to enqueue backfill job: ${(e as Error).message}`);
      return false;
    }
  }

  async purgeAuditQueueForJobIds(jobIds: string[]): Promise<number> {
    if (!jobIds.length || !this.canUseRedis()) return 0;
    const idSet = new Set(jobIds);
    try {
      const items = await this.redisClient.lrange(AUDIT_QUEUE, 0, -1);
      if (!items.length) return 0;
      const kept: string[] = [];
      let removed = 0;
      for (const raw of items) {
        try {
          const payload = JSON.parse(raw) as AuditQueuePayload;
          if (payload?.jobId && idSet.has(payload.jobId)) {
            removed++;
            continue;
          }
        } catch {
          kept.push(raw);
          continue;
        }
        kept.push(raw);
      }
      if (removed === 0) return 0;
      const multi = this.redisClient.multi();
      multi.del(AUDIT_QUEUE);
      if (kept.length) {
        for (let i = kept.length - 1; i >= 0; i--) {
          multi.rpush(AUDIT_QUEUE, kept[i]);
        }
      }
      await multi.exec();
      this.logger.log(`Purged ${removed} audit queue item(s)`);
      return removed;
    } catch (e) {
      this.handleRedisError(e);
      this.logger.warn(`purgeAuditQueueForJobIds failed: ${(e as Error).message}`);
      return 0;
    }
  }

  async purgeAuditQueue(): Promise<number> {
    if (!this.canUseRedis()) return 0;
    try {
      const len = await this.redisClient.llen(AUDIT_QUEUE);
      if (len > 0) await this.redisClient.del(AUDIT_QUEUE);
      if (len > 0) this.logger.log(`Cleared audit queue (${len} item(s))`);
      return len;
    } catch (e) {
      this.handleRedisError(e);
      this.logger.warn(`purgeAuditQueue failed: ${(e as Error).message}`);
      return 0;
    }
  }

  async purgeBackfillQueue(): Promise<number> {
    if (!this.canUseRedis()) return 0;
    try {
      const len = await this.redisClient.llen(BACKFILL_QUEUE);
      if (len > 0) await this.redisClient.del(BACKFILL_QUEUE);
      if (len > 0) this.logger.log(`Cleared backfill queue (${len} item(s))`);
      return len;
    } catch (e) {
      this.handleRedisError(e);
      this.logger.warn(`purgeBackfillQueue failed: ${(e as Error).message}`);
      return 0;
    }
  }
}
