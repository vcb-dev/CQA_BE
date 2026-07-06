import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './src/app.module';
import { CskhInboxService } from './src/cskh/inbox/cskh-inbox.service';
import { PrismaService } from './src/prisma/prisma.service';

// Cách chạy:
//   ts-node backfill-inbox.ts all        -> quét đầy đủ TẤT CẢ page
//   ts-node backfill-inbox.ts empty      -> chỉ quét những page đang RỖNG (0 tin) — nhanh, có thể chạy lại
//   ts-node backfill-inbox.ts <pageId>   -> quét đầy đủ 1 page
async function main() {
  const target = process.argv[2] || 'all';
  const logger = new Logger('Backfill');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const inbox = app.get(CskhInboxService);
  const prisma = app.get(PrismaService);

  const before = await prisma.cskhInboxMessage.count();
  logger.log(`Tổng tin nhắn trong DB trước backfill: ${before}`);
  const t0 = Date.now();

  if (target === 'empty') {
    // Lấy danh sách page đang RỖNG (không có tin nhắn nào), quét lần lượt từng page.
    // Cách này nhanh (bỏ qua page đã có dữ liệu) và RESUMABLE: chạy lại sẽ tự bỏ page đã xong.
    const emptyRows = await prisma.$queryRawUnsafe<
      Array<{ pageId: string; pageName: string | null }>
    >(`
      SELECT cfg.page_id AS "pageId", cfg.page_name AS "pageName"
      FROM facebook_cskh_configs cfg
      WHERE cfg.page_access_token IS NOT NULL
        AND cfg.page_access_token <> ''
        AND NOT EXISTS (
          SELECT 1 FROM cskh_inbox_conversations c
          JOIN cskh_inbox_messages m ON m.conversation_id = c.id
          WHERE c.page_id = cfg.page_id
        )
      ORDER BY cfg.page_name ASC
    `);
    logger.log(`Có ${emptyRows.length} page RỖNG cần quét.`);
    let totalSynced = 0;
    let done = 0;
    for (const row of emptyRows) {
      done++;
      logger.log(`(${done}/${emptyRows.length}) Quét: ${row.pageName || row.pageId} ...`);
      try {
        const r = await inbox.syncFromGraph(row.pageId, undefined, {
          full: true,
          lightweight: true,
        });
        totalSynced += r.synced;
        logger.log(`   → +${r.synced} tin (tổng cộng đã thêm ${totalSynced})`);
      } catch (e) {
        logger.error(`   → LỖI page ${row.pageName || row.pageId}: ${(e as Error).message}`);
      }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    logger.log(`KẾT QUẢ empty: đã thêm ${totalSynced} tin, thời gian=${secs}s`);
  } else {
    const pageId = target === 'all' ? undefined : target;
    logger.log(`Bắt đầu quét ĐẦY ĐỦ (full) cho: ${pageId || 'TẤT CẢ page'} ...`);
    const result = await inbox.syncFromGraph(pageId, undefined, { full: true });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    logger.log(
      `KẾT QUẢ: synced=${result.synced}, okPages=${result.okPages}/${result.pageCount}, ` +
        `lỗi=${result.failedPages.length}, thời gian=${secs}s`,
    );
    if (result.failedPages.length) {
      logger.warn(
        `Page lỗi: ${result.failedPages.map((f) => `${f.page} (${f.error})`).join(' | ')}`,
      );
    }
  }

  const after = await prisma.cskhInboxMessage.count();
  logger.log(`Tổng tin nhắn trong DB sau backfill: ${after} (tăng ${after - before})`);

  await app.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('Backfill lỗi:', e);
  process.exit(1);
});
