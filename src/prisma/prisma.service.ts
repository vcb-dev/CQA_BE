import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { getCskhRunMode } from '../cskh/cskh-run-mode';

function stripEnvQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Supabase transaction pooler (:6543 + pgbouncer) đôi khi trả
 * "cannot execute UPDATE/INSERT in a read-only transaction".
 * Ưu tiên DIRECT_URL / session port :5432 cho runtime Nest (cần ghi).
 */
function preferWritableSessionUrl(url: string): string {
  if (!url) return url;
  let out = url;
  if (out.includes(':6543/')) {
    out = out.replace(':6543/', ':5432/');
  }
  out = out
    .replace(/([?&])pgbouncer=true&?/gi, '$1')
    .replace(/[?&]$/, '')
    .replace(/\?&/, '?');
  return out;
}

/** Railway đôi khi lưu DATABASE_URL kèm quote hoặc để trống — fallback từ DB_* nếu có. */
function resolveDatabaseUrl(): string {
  const direct = stripEnvQuotes(process.env.DIRECT_URL || '');
  if (direct.startsWith('postgresql://') || direct.startsWith('postgres://')) {
    return preferWritableSessionUrl(direct);
  }

  let url = stripEnvQuotes(process.env.DATABASE_URL || '');
  if (url.startsWith('postgresql://') || url.startsWith('postgres://')) {
    return preferWritableSessionUrl(url);
  }

  const host = stripEnvQuotes(process.env.DB_HOST || '');
  const port = stripEnvQuotes(process.env.DB_PORT || '5432');
  const user = stripEnvQuotes(process.env.DB_USERNAME || '');
  const password = process.env.DB_PASSWORD || '';
  const dbName = stripEnvQuotes(process.env.DB_NAME || 'postgres');

  if (host && user && password) {
    const encodedPass = encodeURIComponent(password);
    const built = `postgresql://${user}:${encodedPass}@${host}:${port}/${dbName}`;
    return preferWritableSessionUrl(built);
  }

  return preferWritableSessionUrl(url);
}

function resolvePrismaConnectionLimit(): number {
  // Supabase session pool ~15. API + worker + dashboard/HRM phải chia nhau.
  // CSKH_PRISMA_CONNECTION_LIMIT=7 trên cả hai process hôm qua = 14 slot → tràn pool.
  const dbPoolSize = Number(process.env.CSKH_DB_POOL_SIZE || 15);
  const reserve = Number(process.env.CSKH_DB_POOL_RESERVE || 6);
  const available = Math.max(4, dbPoolSize - reserve);

  if (getCskhRunMode() === 'worker') {
    const worker = Number(process.env.CSKH_PRISMA_WORKER_CONNECTIONS || 2);
    const wanted = Number.isFinite(worker) && worker > 0 ? worker : 2;
    return Math.max(1, Math.min(wanted, 3));
  }

  const workerBudget = Number(process.env.CSKH_PRISMA_WORKER_CONNECTIONS || 2);
  const apiEnv = Number(
    process.env.CSKH_PRISMA_API_CONNECTIONS || process.env.CSKH_PRISMA_CONNECTION_LIMIT,
  );
  // API cần ≥3: JWT + list hội thoại + stats. 2 slot → list chờ 20s rồi trống.
  const wanted = Number.isFinite(apiEnv) && apiEnv > 0 ? Math.max(apiEnv, 3) : 4;
  return Math.max(3, Math.min(wanted, 5, Math.max(3, available - workerBudget)));
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const rawEnvUrl = process.env.DATABASE_URL || '';
    const baseUrl = resolveDatabaseUrl();
    let url = baseUrl;

    const connectionLimit = resolvePrismaConnectionLimit();
    const limit = `connection_limit=${connectionLimit}`;
    const poolTimeout = 'pool_timeout=20';
    if (url) {
      if (!url.includes('connection_limit=')) {
        url += (url.includes('?') ? '&' : '?') + limit;
      } else {
        url = url.replace(/connection_limit=\d+/, limit);
      }
      if (!url.includes('pool_timeout=')) {
        url += (url.includes('?') ? '&' : '?') + poolTimeout;
      }
    }

    super({
      datasources: {
        db: {
          url: url,
        },
      },
    });

    if (baseUrl && baseUrl !== stripEnvQuotes(rawEnvUrl)) {
      this.logger.warn('DATABASE_URL invalid or missing — built connection string from DB_HOST/DB_* env.');
    }
    const direct = stripEnvQuotes(process.env.DIRECT_URL || '');
    if (direct) {
      this.logger.log('Prisma using DIRECT_URL (session) for writable runtime connection.');
    } else if (stripEnvQuotes(rawEnvUrl).includes(':6543')) {
      this.logger.warn(
        'DATABASE_URL was :6543 pooler — rewritten to :5432 session to avoid read-only writes. Prefer setting DIRECT_URL on Railway.',
      );
    }
    if (url) {
      this.logger.log(
        `Prisma connection limit enforced at ${connectionLimit} (${getCskhRunMode()} process, db pool budget ${process.env.CSKH_DB_POOL_SIZE || 15}).`,
      );
    } else {
      this.logger.error('DATABASE_URL is empty — set DATABASE_URL or DB_HOST+DB_USERNAME+DB_PASSWORD on Railway.');
    }
  }

  async onModuleInit(): Promise<void> {
    const attempts = 5;
    for (let i = 1; i <= attempts; i++) {
      try {
        await this.$connect();
        break;
      } catch (e) {
        if (i === attempts) throw e;
        const delay = i * 2_000;
        this.logger.warn(
          `Prisma connect failed (${i}/${attempts}): ${(e as Error).message}. Retry in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    // Session có thể inherit default_transaction_read_only=on từ role/pooler.
    try {
      await this.$executeRawUnsafe('SET default_transaction_read_only = off');
      await this.$executeRawUnsafe(
        'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
      );
    } catch (e) {
      this.logger.warn(
        `Could not force read-write session: ${(e as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

export { Prisma } from '@prisma/client';
