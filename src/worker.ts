import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { getCskhRunMode } from './cskh/cskh-run-mode';

/**
 * Worker process — chỉ chạy Redis queue (audit + intent), không mở HTTP.
 * Railway: deploy service thứ 2 cùng Docker image, Start Command: node dist/worker.js
 * Env: CSKH_RUN_MODE=worker, REDIS_URL=..., DATABASE_URL=...
 */
async function bootstrapWorker() {
  if (!process.env.CSKH_RUN_MODE) {
    process.env.CSKH_RUN_MODE = 'worker';
  }

  const logger = new Logger('CskhWorker');
  const mode = getCskhRunMode();
  if (mode !== 'worker' && mode !== 'all') {
    logger.error(`worker.js requires CSKH_RUN_MODE=worker (current: ${mode})`);
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  logger.log(`CSKH Worker started (mode=${mode}) — webhook + pancake-sync/label + backfill + audit + intent`);

  const shutdown = async (signal: string) => {
    logger.warn(`${signal} — shutting down worker`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrapWorker();
