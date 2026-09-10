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
 * Ghi/đọc mốc "Hoạt động cuối" của user qua Redis.
 * DB dùng chung không có cột last_login → dùng Redis, degrade an toàn khi Redis chết.
 */
@Injectable()
export class RbacActivityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RbacActivityService.name);
  private redis: Redis | null = null;
  private readonly lastWrite = new Map<string, number>();

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
      this.logger.warn('Redis last-active không sẵn sàng — cột "Hoạt động cuối" trống');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit().catch(() => undefined);
  }

  /** Ghi mốc hoạt động. Throttle 5 phút/user. Fire-and-forget — không ném lỗi. */
  async markActive(userId: bigint | number | string): Promise<void> {
    const key = String(userId);
    const now = Date.now();
    if (now - (this.lastWrite.get(key) ?? 0) < THROTTLE_MS) return;
    this.lastWrite.set(key, now);
    if (!isRedisClientReady(this.redis)) return;
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

  /** Map String(userId) → ISO timestamp. Redis chết hoặc list rỗng → Map rỗng. */
  async getActiveMap(
    userIds: Array<bigint | number | string>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (userIds.length === 0 || !isRedisClientReady(this.redis)) return out;
    try {
      const keys = userIds.map((id) => `${KEY_PREFIX}${id}`);
      const values = await this.redis!.mget(...keys);
      userIds.forEach((id, i) => {
        const v = values[i];
        if (v) out.set(String(id), v);
      });
    } catch (e) {
      this.logger.warn(`getActiveMap lỗi: ${(e as Error).message}`);
    }
    return out;
  }
}
