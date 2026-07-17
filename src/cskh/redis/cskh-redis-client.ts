import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';
import {
  isRedisCircuitOpen,
  isRedisQuotaError,
  onRedisQuotaTripped,
} from './cskh-redis-circuit';

export type RedisConnectionConfig = {
  url?: string;
  host: string;
  port: number;
  password?: string;
};

export function isRedisDisabledByEnv(): boolean {
  return process.env.CSKH_REDIS_ENABLED === 'false';
}

export function resolveRedisConnectionConfig(
  configService: ConfigService,
): RedisConnectionConfig {
  const cleanValue = (val: unknown) => {
    if (typeof val !== 'string') return val;
    return val.trim().replace(/^['"]|['"]$/g, '');
  };

  const redisUrl = cleanValue(configService.get<string>('REDIS_URL'));
  const host = cleanValue(configService.get<string>('REDIS_HOST')) || 'localhost';
  const port = Number(configService.get<number>('REDIS_PORT')) || 6379;
  const password =
    cleanValue(
      configService.get<string>('REDIS_PASSWORD') ||
        configService.get<string>('REDISPASSWORD'),
    ) || undefined;

  return {
    url: typeof redisUrl === 'string' && redisUrl ? redisUrl : undefined,
    host: host as string,
    port,
    password: password as string | undefined,
  };
}

export type CreateCskhRedisOpts = {
  blocking?: boolean;
  logger?: Logger;
  label?: string;
};

/** Tạo client Redis an toàn — lazyConnect, không crash khi Upstash hết quota. */
export function createCskhRedisClient(
  config: RedisConnectionConfig,
  opts?: CreateCskhRedisOpts,
): Redis | null {
  if (isRedisDisabledByEnv() || isRedisCircuitOpen()) return null;

  const base: RedisOptions = {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: opts?.blocking ? null : 1,
    retryStrategy(times) {
      if (isRedisCircuitOpen() || times > 2) return null;
      return Math.min(times * 500, 2000);
    },
    reconnectOnError(err) {
      if (isRedisQuotaError(err) || isRedisCircuitOpen()) return false;
      const msg = (err as Error)?.message ?? '';
      return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(msg);
    },
  };

  const client = config.url
    ? new Redis(config.url, base)
    : new Redis({
        host: config.host,
        port: config.port,
        password: config.password,
        ...base,
      });

  const log = opts?.logger;
  const label = opts?.label ?? 'redis';
  client.on('error', (e) => {
    if (isRedisQuotaError(e)) {
      onRedisQuotaTripped(log);
      void client.disconnect(false);
      return;
    }
    log?.warn?.(`${label} error: ${(e as Error).message}`);
  });

  return client;
}

export async function connectCskhRedis(
  client: Redis | null,
  opts?: { logger?: Logger; label?: string },
): Promise<boolean> {
  if (!client) return false;
  if (isRedisCircuitOpen()) return false;
  try {
    await client.connect();
    return client.status === 'ready';
  } catch (e) {
    if (isRedisQuotaError(e)) {
      onRedisQuotaTripped(opts?.logger);
    } else {
      opts?.logger?.warn?.(
        `${opts?.label ?? 'redis'} connect failed: ${(e as Error).message}`,
      );
    }
    try {
      client.disconnect(false);
    } catch {
      /* ignore */
    }
    return false;
  }
}

export function isRedisClientReady(client: Redis | null | undefined): boolean {
  return !!client && client.status === 'ready' && !isRedisCircuitOpen();
}
