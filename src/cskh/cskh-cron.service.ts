import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CskhService } from './cskh.service';
import { CskhInboxService } from './inbox/cskh-inbox.service';
import { RedisQueueService } from './redis/redis-queue.service';
import { isCskhApiProcess, isCskhWorkerProcess } from './cskh-run-mode';

@Injectable()
export class CskhCronService {
  private readonly logger = new Logger(CskhCronService.name);
  constructor(
    private readonly cskh: CskhService,
    private readonly inbox: CskhInboxService,
    private readonly redisQueue: RedisQueueService,
  ) {}

  /**
   * 2:00 AM — xếp hàng "Quét đầy đủ" (worker thực thi, không chạy nặng trên API).
   * Tắt bằng env CSKH_BACKFILL_CRON_ENABLED=false.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledBackfill() {
    if (!isCskhApiProcess()) return;
    if (process.env.CSKH_BACKFILL_CRON_ENABLED === 'false') return;
    try {
      const status = await this.inbox.startBackfill('all', undefined, { force: true });
      if (status.running) {
        this.logger.log(
          `[cron] Quét đầy đủ ban đêm bắt đầu — ${status.total} kênh.`,
        );
      } else {
        this.logger.log('[cron] Bỏ qua quét đêm — đang có tiến trình quét khác chạy.');
      }
    } catch (e) {
      this.logger.error(`[cron] Quét đầy đủ ban đêm lỗi: ${(e as Error).message}`);
    }
  }

  /**
   * 2:30 AM VN — audit ban đêm (xếp hàng worker, không chờ từng job trên API).
   */
  @Cron('0 30 2 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledAudit() {
    if (!isCskhApiProcess()) return;
    if (process.env.CSKH_CRON_ENABLED !== 'true') return;

    const { maxConversations, lookbackDays } = this.cskh.getAuditCronDefaults();
    const { auditDateFrom, auditDateTo } = this.cskh.buildAuditDateRange(lookbackDays);

    this.logger.log(
      `Nightly scheduled audit starting — ${maxConversations} cuộc/kênh, khoảng ${auditDateFrom} → ${auditDateTo}`,
    );

    try {
      const connectedPages = await this.cskh.listConnectedPages();
      if (connectedPages.length === 0) {
        this.logger.log('No connected pages found for scheduled audit.');
        return;
      }

      this.logger.log(`Found ${connectedPages.length} connected pages to audit.`);

      let enqueued = 0;
      for (const page of connectedPages) {
        const activeJob = await this.cskh.findRunningJob('audit');
        if (activeJob) {
          this.logger.log(`Detected another running audit job (${activeJob.id}). Aborting nightly cron loop.`);
          break;
        }

        try {
          const job = await this.cskh.createJob('audit', page.tenantId || undefined);
          const auditOpts = {
            auditDateFrom,
            auditDateTo,
            pageId: page.pageId,
            maxConversations,
            force: true,
          };
          const queued = await this.redisQueue.enqueueAuditJob({
            jobId: job.id,
            options: auditOpts,
          });
          if (!queued) {
            this.logger.warn(
              `[cron] Redis queue off — bỏ audit page=${page.pageId} (không chạy inline trên API)`,
            );
          }
          enqueued++;
          this.logger.log(
            `Nightly audit enqueued for page=${page.pageName || page.pageId} job=${job.id}`,
          );
        } catch (err) {
          this.logger.error(
            `Failed to enqueue audit for page ${page.pageId}: ${(err as Error).message}`,
          );
        }

        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }

      this.logger.log(`Nightly scheduled audit enqueued ${enqueued} job(s).`);
    } catch (e) {
      this.logger.error(`Scheduled audit failed: ${(e as Error).message}`);
    }
  }

  /**
   * 4:00 AM VN — đồng bộ chi tiêu QC theo Page (hôm qua + hôm nay).
   * Tách khỏi 2AM để không tranh backfill/audit. Tắt: CSKH_PAGE_AD_SYNC_CRON_ENABLED=false
   */
  @Cron('0 0 4 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledPageAdSpendSync() {
    if (!isCskhWorkerProcess()) return;
    if (process.env.CSKH_PAGE_AD_SYNC_CRON_ENABLED === 'false') return;
    if (await this.redisQueue.shouldDeferInboxSync()) {
      this.logger.log('[cron] Bỏ qua chi tiêu QC — inbox đang bận');
      return;
    }
    try {
      const today = this.cskh.vietnamCalendarDate(0);
      const yesterday = this.cskh.vietnamCalendarDate(-1);
      this.logger.log(`[cron] Đồng bộ chi tiêu QC Page/Kênh — ${yesterday}, ${today}`);
      const result = await this.cskh.syncAllPagesAdSpend([yesterday, today]);
      this.logger.log(
        `[cron] Chi tiêu QC xong: ${result.synced} bản ghi / ${result.pages} kênh × ${result.dates.length} ngày`,
      );
    } catch (e) {
      this.logger.error(`[cron] Đồng bộ chi tiêu QC Page/Kênh lỗi: ${(e as Error).message}`);
    }
  }
}
