import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  isRedisCircuitOpen,
  isRedisQuotaError,
  onRedisQuotaTripped,
} from './cskh-redis-circuit';
import { getCskhRunMode, isCskhApiProcess } from '../cskh-run-mode';

const INBOX_HOT_KEY = 'cskh:inbox:hot';
const INBOX_SYNC_KEY = 'cskh:inbox:sync';
const AUDIT_PAUSE_PREFIX = 'cskh:audit:pause:';
const BACKFILL_PAUSE_PREFIX = 'cskh:backfill:pause:';
const BACKFILL_CANCEL_PREFIX = 'cskh:backfill:cancel:';
const PAGE_STATS_BUST_PREFIX = 'cskh:page-stats:bust:';
/** Worker đọc Redis tối đa 1 lần / 30s (MGET gộp hot+sync). */
const REMOTE_SIGNALS_TTL_MS = 30_000;

/**
 * Tín hiệu nhẹ qua Redis (inbox hot, audit pause).
 * API process: đọc memory-only — không GET Redis.
 * Worker: MGET gộp, cache 30s.
 */
@Injectable()
export class CskhRedisSignalsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CskhRedisSignalsService.name);
  private redis: Redis | null = null;

  private inboxHotUntil = 0;
  private inboxSyncUntil = 0;
  private lastInboxHotRedisWrite = 0;
  private lastInboxSyncRedisWrite = 0;
  private auditPauseLocal = new Map<string, number>();
  private pageStatsBustLocal = 0;

  private remoteSignalsCheckedAt = 0;
  private remoteInboxHot = false;
  private remoteInboxSync = false;

  constructor(private readonly configService: ConfigService) {}

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
      this.redis = new Redis(redisUrl as string, { maxRetriesPerRequest: 2 });
    } else {
      this.redis = new Redis({
        host: host as string,
        port,
        password: password as string | undefined,
        maxRetriesPerRequest: 2,
      });
    }
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
  }

  private canUseRedis(): boolean {
    return !!this.redis && !isRedisCircuitOpen();
  }

  /** API-only deploy: không cần đọc Redis — NV dùng inbox trên cùng process. */
  private isApiMemoryOnly(): boolean {
    return isCskhApiProcess() && getCskhRunMode() === 'api';
  }

  private handleRedisError(e: unknown): void {
    if (isRedisQuotaError(e)) onRedisQuotaTripped(this.logger);
  }

  private async refreshRemoteSignals(): Promise<void> {
    if (this.isApiMemoryOnly()) return;
    if (Date.now() - this.remoteSignalsCheckedAt < REMOTE_SIGNALS_TTL_MS) return;
    if (!this.canUseRedis()) return;
    try {
      const [hot, sync] = await this.redis!.mget(INBOX_HOT_KEY, INBOX_SYNC_KEY);
      this.remoteInboxHot = !!hot;
      this.remoteInboxSync = !!sync;
      this.remoteSignalsCheckedAt = Date.now();
      if (hot) this.inboxHotUntil = Date.now() + 30_000;
      if (sync) this.inboxSyncUntil = Date.now() + 30_000;
    } catch (e) {
      this.handleRedisError(e);
    }
  }

  async markInboxActivity(ttlSeconds = 90): Promise<void> {
    this.inboxHotUntil = Date.now() + ttlSeconds * 1000;
    if (!this.canUseRedis()) return;
    const now = Date.now();
    if (now - this.lastInboxHotRedisWrite < 60_000) return;
    this.lastInboxHotRedisWrite = now;
    try {
      await this.redis!.set(INBOX_HOT_KEY, String(now), 'EX', ttlSeconds);
    } catch (e) {
      this.handleRedisError(e);
    }
  }

  async isInboxHot(): Promise<boolean> {
    if (Date.now() < this.inboxHotUntil) return true;
    if (this.isApiMemoryOnly()) return false;
    await this.refreshRemoteSignals();
    return this.remoteInboxHot;
  }

  async markInboxSyncActive(ttlSeconds = 120): Promise<void> {
    this.inboxSyncUntil = Date.now() + ttlSeconds * 1000;
    if (!this.canUseRedis()) return;
    const now = Date.now();
    if (now - this.lastInboxSyncRedisWrite < 60_000) return;
    this.lastInboxSyncRedisWrite = now;
    try {
      await this.redis!.set(INBOX_SYNC_KEY, String(now), 'EX', ttlSeconds);
    } catch (e) {
      this.handleRedisError(e);
    }
  }

  async isInboxSyncActive(): Promise<boolean> {
    if (Date.now() < this.inboxSyncUntil) return true;
    if (this.isApiMemoryOnly()) return false;
    await this.refreshRemoteSignals();
    return this.remoteInboxSync;
  }

  async clearInboxSyncActive(): Promise<void> {
    this.inboxSyncUntil = 0;
    this.remoteInboxSync = false;
    if (!this.canUseRedis()) return;
    try {
      await this.redis!.del(INBOX_SYNC_KEY);
    } catch (e) {
      this.handleRedisError(e);
    }
  }

  async shouldYieldGraphToInbox(): Promise<boolean> {
    if (Date.now() < this.inboxHotUntil || Date.now() < this.inboxSyncUntil) return true;
    if (this.isApiMemoryOnly()) return false;
    await this.refreshRemoteSignals();
    return this.remoteInboxHot || this.remoteInboxSync;
  }

  async waitWhileInboxHot(maxWaitMs = 90_000): Promise<void> {
    const start = Date.now();
    while (await this.isInboxHot()) {
      if (Date.now() - start > maxWaitMs) return;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  async setAuditPauseRequested(jobId: string): Promise<void> {
    this.auditPauseLocal.set(jobId, Date.now() + 86_400_000);
    if (!this.canUseRedis()) return;
    try {
      await this.redis!.set(`${AUDIT_PAUSE_PREFIX}${jobId}`, '1', 'EX', 86_400);
    } catch (e) {
      this.handleRedisError(e);
    }
  }

  async isAuditPauseRequested(jobId: string): Promise<boolean> {
    const local = this.auditPauseLocal.get(jobId);
    if (local && local > Date.now()) return true;
    if (local) this.auditPauseLocal.delete(jobId);
    if (!this.canUseRedis()) return false;
    try {
      return !!(await this.redis!.get(`${AUDIT_PAUSE_PREFIX}${jobId}`));
    } catch (e) {
      this.handleRedisError(e);
      return false;
    }
  }

  async clearAuditPauseRequested(jobId: string): Promise<void> {
    this.auditPauseLocal.delete(jobId);
    if (!this.canUseRedis()) return;
    try {
      await this.redis!.del(`${AUDIT_PAUSE_PREFIX}${jobId}`);
    } catch (e) {
      this.handleRedisError(e);
    }
  }

  async setBackfillPauseRequested(jobId: string): Promise<void> {
    if (!this.canUseRedis()) return;
    try {
      await this.redis!.set(`${BACKFILL_PAUSE_PREFIX}${jobId}`, '1', 'EX', 86_400);
    } catch (e) {
      this.handleRedisError(e);
    }
  }

  async isBackfillPauseRequested(jobId: string): Promise<boolean> {
    if (!this.canUseRedis()) return false;
    try {
      return !!(await this.redis!.get(`${BACKFILL_PAUSE_PREFIX}${jobId}`));
    } catch (e) {
      this.handleRedisError(e);
      return false;
    }
  }

  async clearBackfillPauseRequested(jobId: string): Promise<void> {
    if (!this.canUseRedis()) return;
    try {
      await this.redis!.del(`${BACKFILL_PAUSE_PREFIX}${jobId}`);
    } catch (e) {
      this.handleRedisError(e);
    }
  }

  async setBackfillCancelRequested(jobId: string): Promise<void> {
    if (!this.canUseRedis()) return;
    try {
      await this.redis!.set(`${BACKFILL_CANCEL_PREFIX}${jobId}`, '1', 'EX', 86_400);
    } catch (e) {
      this.handleRedisError(e);
    }
  }

  async isBackfillCancelRequested(jobId: string): Promise<boolean> {
    if (!this.canUseRedis()) return false;
    try {
      return !!(await this.redis!.get(`${BACKFILL_CANCEL_PREFIX}${jobId}`));
    } catch (e) {
      this.handleRedisError(e);
      return false;
    }
  }

  async clearBackfillCancelRequested(jobId: string): Promise<void> {
    if (!this.canUseRedis()) return;
    try {
      await this.redis!.del(`${BACKFILL_CANCEL_PREFIX}${jobId}`);
    } catch (e) {
      this.handleRedisError(e);
    }
  }

  /** Worker quét xong kênh → API process biết để bỏ cache thống kê Page/Kênh. */
  async bumpPageStatsCache(tenantId?: string): Promise<void> {
    const now = Date.now();
    this.pageStatsBustLocal = now;
    if (!this.canUseRedis()) return;
    try {
      const payload = String(now);
      const ttl = 3_600;
      await this.redis!.set(`${PAGE_STATS_BUST_PREFIX}__all__`, payload, 'EX', ttl);
      if (tenantId) {
        await this.redis!.set(`${PAGE_STATS_BUST_PREFIX}${tenantId}`, payload, 'EX', ttl);
      }
    } catch (e) {
      this.handleRedisError(e);
    }
  }

  async getPageStatsCacheBustAt(tenantId?: string): Promise<number> {
    let bust = this.pageStatsBustLocal;
    if (!this.canUseRedis()) return bust;
    try {
      const keys = [
        `${PAGE_STATS_BUST_PREFIX}__all__`,
        `${PAGE_STATS_BUST_PREFIX}${tenantId ?? '__all__'}`,
      ];
      const values = await this.redis!.mget(...keys);
      for (const v of values) {
        const n = v ? Number(v) : 0;
        if (Number.isFinite(n) && n > bust) bust = n;
      }
    } catch (e) {
      this.handleRedisError(e);
    }
    return bust;
  }
}
