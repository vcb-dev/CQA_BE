import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import {
  connectCskhRedis,
  createCskhRedisClient,
  isRedisClientReady,
  isRedisDisabledByEnv,
  resolveRedisConnectionConfig,
} from '../cskh/redis/cskh-redis-client';

const KEY_PREFIX = 'rbac:last_active:';
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 ngày
const THROTTLE_MS = 5 * 60_000; // ghi Redis tối đa 1 lần / 5 phút / user

/**
 * Ghi/đọc mốc "Hoạt động cuối" của user.
 *
 * DB dùng chung không có cột last_login nên mốc này nằm ngoài DB:
 * - Bộ nhớ process: luôn ghi, luôn đọc được — mất khi restart, không chia sẻ giữa nhiều instance.
 * - Redis: bản chia sẻ + bền, ghi tối đa 1 lần / 5 phút / user để khỏi spam.
 *
 * Không có Redis thì cột vẫn chạy, chỉ trong phạm vi 1 process.
 */
@Injectable()
export class RbacActivityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RbacActivityService.name);
  private redis: Redis | null = null;
  /** userId → { at: mốc hoạt động cuối, syncedAt: lần cuối đẩy lên Redis }. */
  private readonly lastActive = new Map<
    string,
    { at: number; syncedAt: number }
  >();

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    if (isRedisDisabledByEnv()) {
      this.logger.warn('CSKH_REDIS_ENABLED=false — không ghi "Hoạt động cuối"');
      return;
    }
    const cfg = resolveRedisConnectionConfig(this.configService);
    this.redis = createCskhRedisClient(cfg, {
      logger: this.logger,
      label: 'rbac-activity',
    });
    const ok = await connectCskhRedis(this.redis, {
      logger: this.logger,
      label: 'rbac-activity',
    });
    if (!ok) {
      this.redis = null;
      this.logger.warn(
        'Redis last-active không sẵn sàng — cột "Hoạt động cuối" trống',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit().catch(() => undefined);
  }

  /**
   * Ghi mốc hoạt động. Bộ nhớ ghi mọi lần; Redis throttle 5 phút/user.
   * Fire-and-forget — lỗi Redis không được ném ra.
   */
  async markActive(userId: bigint | number | string): Promise<void> {
    const key = String(userId);
    const now = Date.now();
    const syncedAt = this.lastActive.get(key)?.syncedAt ?? 0;
    const shouldSync = now - syncedAt >= THROTTLE_MS;

    this.lastActive.set(key, {
      at: now,
      syncedAt: shouldSync ? now : syncedAt,
    });

    if (!shouldSync || !isRedisClientReady(this.redis)) return;
    try {
      await this.redis!.set(
        `${KEY_PREFIX}${key}`,
        new Date(now).toISOString(),
        'EX',
        TTL_SECONDS,
      );
    } catch (e) {
      this.logger.warn(`markActive ${key} lỗi: ${(e as Error).message}`);
    }
  }

  /**
   * Map String(userId) → ISO timestamp. Gộp bộ nhớ process với Redis,
   * lấy mốc mới hơn. Redis chết → vẫn trả được phần trong bộ nhớ.
   */
  async getActiveMap(
    userIds: Array<bigint | number | string>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (userIds.length === 0) return out;

    const localMs = new Map<string, number>();
    for (const id of userIds) {
      const key = String(id);
      const entry = this.lastActive.get(key);
      if (entry) {
        localMs.set(key, entry.at);
        out.set(key, new Date(entry.at).toISOString());
      }
    }

    if (!isRedisClientReady(this.redis)) return out;
    try {
      const keys = userIds.map((id) => `${KEY_PREFIX}${id}`);
      const values = await this.redis!.mget(...keys);
      userIds.forEach((id, i) => {
        const v = values[i];
        if (!v) return;
        const key = String(id);
        const remoteMs = new Date(v).getTime();
        if (Number.isNaN(remoteMs)) return;
        // Bộ nhớ có thể mới hơn Redis vì Redis chỉ ghi 5 phút/lần.
        if (remoteMs > (localMs.get(key) ?? 0)) out.set(key, v);
      });
    } catch (e) {
      this.logger.warn(`getActiveMap lỗi: ${(e as Error).message}`);
    }
    return out;
  }
}
