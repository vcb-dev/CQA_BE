import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppModule } from './src/app.module';
import { CskhInboxService } from './src/cskh/inbox/cskh-inbox.service';
import { PrismaService } from './src/prisma/prisma.service';

const PAGE_IDS = ['1000414629821406', '493091231045743'];

async function main() {
  const logger = new Logger('ResetBackfillPages');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const inbox = app.get(CskhInboxService);
  const prisma = app.get(PrismaService);

  const cancel = await inbox.cancelAllBackfill();
  logger.log(`Cancel: ${cancel.message}`);

  const job = await prisma.cskhJobRun.findFirst({
    where: { type: 'inbox-backfill' },
    orderBy: { startedAt: 'desc' },
  });
  if (!job) {
    logger.warn('Không có job backfill nào');
    await app.close();
    return;
  }

  const summary = (job.summary as Record<string, unknown> | null) ?? {};
  const completed = (summary.completedPageIds as string[]) ?? [];
  const removed = completed.filter((id) => PAGE_IDS.includes(id));
  const newCompleted = completed.filter((id) => !PAGE_IDS.includes(id));
  const removedCount = removed.length;

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
    new Date(),
  );
  const yesterday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(Date.now() - 86_400_000));

  const adDeleted = await prisma.cskhPageAdSpendDaily.deleteMany({
    where: {
      pageId: { in: PAGE_IDS },
      statDate: { in: [today, yesterday] },
    },
  });

  await prisma.cskhJobRun.update({
    where: { id: job.id },
    data: {
      status: 'paused',
      finishedAt: null,
      summary: {
        ...summary,
        completedPageIds: newCompleted,
        done: Math.max(0, Number(summary.done ?? 0) - removedCount),
        okPages: Math.max(0, Number(summary.okPages ?? 0) - removedCount),
        currentPage: null,
        pageConvsDone: 0,
        pauseRequested: false,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  logger.log(
    `Job ${job.id.slice(0, 8)}: bỏ ${removedCount} kênh khỏi đã quét (${removed.join(', ')})`,
  );
  logger.log(`Xóa ${adDeleted.count} dòng chi tiêu QC (${today}, ${yesterday})`);
  logger.log('→ Vào Page/Kênh bấm "Tiếp tục quét" để quét lại 2 kênh đó');

  await app.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
