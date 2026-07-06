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

/** Railway đôi khi lưu DATABASE_URL kèm quote hoặc để trống — fallback từ DB_* nếu có. */
function resolveDatabaseUrl(): string {
  let url = stripEnvQuotes(process.env.DATABASE_URL || '');
  if (url.startsWith('postgresql://') || url.startsWith('postgres://')) {
    return url;
  }

  const host = stripEnvQuotes(process.env.DB_HOST || '');
  const port = stripEnvQuotes(process.env.DB_PORT || '6543');
  const user = stripEnvQuotes(process.env.DB_USERNAME || '');
  const password = process.env.DB_PASSWORD || '';
  const dbName = stripEnvQuotes(process.env.DB_NAME || 'postgres');

  if (host && user && password) {
    const encodedPass = encodeURIComponent(password);
    const built = `postgresql://${user}:${encodedPass}@${host}:${port}/${dbName}`;
    if (port === '6543' && !built.includes('pgbouncer=')) {
      return `${built}?pgbouncer=true`;
    }
    return built;
  }

  return url;
}

function resolvePrismaConnectionLimit(): number {
  const envOverride = Number(process.env.CSKH_PRISMA_CONNECTION_LIMIT);
  if (Number.isFinite(envOverride) && envOverride > 0) {
    return envOverride;
  }

  const dbPoolSize = Number(process.env.CSKH_DB_POOL_SIZE || 15);
  const reserve = Number(process.env.CSKH_DB_POOL_RESERVE || 4);
  const available = Math.max(4, dbPoolSize - reserve);

  if (getCskhRunMode() === 'worker') {
    const worker = Number(process.env.CSKH_PRISMA_WORKER_CONNECTIONS || 2);
    return Math.min(worker, Math.max(2, Math.floor(available / 3)));
  }

  const workerBudget = Number(process.env.CSKH_PRISMA_WORKER_CONNECTIONS || 2);
  const apiEnv = Number(process.env.CSKH_PRISMA_API_CONNECTIONS);
  if (Number.isFinite(apiEnv) && apiEnv > 0) {
    return Math.min(apiEnv, available - workerBudget);
  }
  // API: đủ cho webhook + sync nhẹ; worker giữ 2 slot — tổng < Supabase pool_size (15).
  return Math.min(6, available - workerBudget);
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
    if (url) {
      if (!url.includes('connection_limit=')) {
        url += (url.includes('?') ? '&' : '?') + limit;
      } else {
        url = url.replace(/connection_limit=\d+/, limit);
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
    if (url) {
      this.logger.log(
        `Prisma connection limit enforced at ${connectionLimit} (${getCskhRunMode()} process, db pool budget ${process.env.CSKH_DB_POOL_SIZE || 15}).`,
      );
    } else {
      this.logger.error('DATABASE_URL is empty — set DATABASE_URL or DB_HOST+DB_USERNAME+DB_PASSWORD on Railway.');
    }
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

export { Prisma } from '@prisma/client';
