import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CskhService } from './cskh.service';
import { CskhInboxService } from './inbox/cskh-inbox.service';
import { RedisQueueService } from './redis/redis-queue.service';
import { getCskhRunMode, isCskhApiProcess } from './cskh-run-mode';

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
   * 2:00 AM VN — đồng bộ chi tiêu QC theo Page (hôm qua + hôm nay) vào DB cho màn Page/Kênh.
   * Tắt: CSKH_PAGE_AD_SYNC_CRON_ENABLED=false
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledPageAdSpendSync() {
    if (!isCskhApiProcess()) return;
    if (process.env.CSKH_PAGE_AD_SYNC_CRON_ENABLED === 'false') return;
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

  /** 2:00 AM — quét 30 cuộc hội thoại gần nhất / kênh (30 ngày gần nhất). */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { timeZone: 'Asia/Ho_Chi_Minh' })
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

      for (const page of connectedPages) {
        // Check if there is any other running audit job in the database (which would be a manual job)
        const activeJob = await this.cskh.findRunningJob('audit');
        if (activeJob) {
          this.logger.log(`Detected another running audit job (${activeJob.id}). Aborting nightly cron loop.`);
          break;
        }

        let jobId = '';
        try {
          const job = await this.cskh.createJob('audit', page.tenantId || undefined);
          jobId = job.id;
          this.logger.log(
            `Nightly audit started for page=${page.pageName || page.pageId} job=${job.id}`,
          );

          await this.redisQueue.enqueueAuditJob({
            jobId: job.id,
            options: {
              auditDateFrom,
              auditDateTo,
              pageId: page.pageId,
              maxConversations,
              force: true,
            },
          });

          while (true) {
            const j = await this.cskh.getJob(job.id);
            if (!j || j.status !== 'running') break;
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }

          this.logger.log(
            `Nightly audit completed for page=${page.pageName || page.pageId} job=${job.id}`,
          );

          // Check if this job was cancelled by user manually
          const finalJob = await this.cskh.getJob(job.id);
          if (finalJob && finalJob.status === 'failed' && finalJob.error === 'Đã hủy bởi người dùng') {
            this.logger.log(`Nightly audit job ${job.id} was cancelled by user. Aborting remaining pages.`);
            break;
          }
        } catch (err) {
          this.logger.error(
            `Failed to audit page ${page.pageId}: ${(err as Error).message}`,
          );
          if (jobId) {
            const finalJob = await this.cskh.getJob(jobId);
            if (finalJob && finalJob.status === 'failed' && finalJob.error === 'Đã hủy bởi người dùng') {
              this.logger.log(`Nightly audit job ${jobId} was cancelled by user (caught error). Aborting remaining pages.`);
              break;
            }
          }
        }

        // Nghỉ giữa các kênh để tránh quá tải AI / Meta API
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      this.logger.log('Nightly scheduled audit finished successfully.');
    } catch (e) {
      this.logger.error(`Scheduled audit failed: ${(e as Error).message}`);
    }
  }
}
