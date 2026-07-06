import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './src/app.module';
import { CskhInboxService } from './src/cskh/inbox/cskh-inbox.service';

/** Hủy toàn bộ job quét đầy đủ đang chạy / trong hàng đợi Redis. */
async function main() {
  const logger = new Logger('CancelBackfill');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const inbox = app.get(CskhInboxService);

  const result = await inbox.cancelAllBackfill();
  logger.log(result.message);
  logger.log(`cancelled=${result.cancelled}, queueCleared=${result.queueCleared}`);

  await app.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('Cancel backfill lỗi:', e);
  process.exit(1);
});
