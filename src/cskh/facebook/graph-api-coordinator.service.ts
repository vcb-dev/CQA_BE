import { Injectable, Logger } from '@nestjs/common';

export type GraphRequestPriority = 'high' | 'low';

/**
 * Điều phối request Facebook Graph — tránh audit và inbox tranh slot gây lag / rate limit.
 * - high: inbox sync, webhook enrich, monitor
 * - low: audit fetch, backfill (bị throttle khi inbox đang sync)
 */
@Injectable()
export class GraphApiCoordinatorService {
  private readonly logger = new Logger(GraphApiCoordinatorService.name);
  private activeHigh = 0;
  private activeLow = 0;
  private inboxSyncDepth = 0;

  private readonly maxHigh = Number(process.env.CSKH_GRAPH_MAX_HIGH || 3);
  private readonly maxLow = Number(process.env.CSKH_GRAPH_MAX_LOW || 2);
  private readonly maxTotal = Number(process.env.CSKH_GRAPH_MAX_TOTAL || 5);

  get inboxSyncActive(): boolean {
    return this.inboxSyncDepth > 0;
  }

  beginInboxSync(): void {
    this.inboxSyncDepth++;
  }

  endInboxSync(): void {
    this.inboxSyncDepth = Math.max(0, this.inboxSyncDepth - 1);
  }

  /** Audit fetch concurrency — giảm khi inbox đang bận. */
  auditFetchConcurrency(defaultConcurrency: number): number {
    if (this.inboxSyncDepth > 0) {
      return 1;
    }
    return defaultConcurrency;
  }

  async acquire(priority: GraphRequestPriority = 'high'): Promise<() => void> {
    const pollMs = priority === 'low' ? 150 : 40;
    while (!this.canAcquire(priority)) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (priority === 'high') this.activeHigh++;
    else this.activeLow++;
    return () => {
      if (priority === 'high') this.activeHigh = Math.max(0, this.activeHigh - 1);
      else this.activeLow = Math.max(0, this.activeLow - 1);
    };
  }

  private maxLowNow(): number {
    if (this.inboxSyncDepth > 0) return 0;
    return this.maxLow;
  }

  private canAcquire(priority: GraphRequestPriority): boolean {
    const total = this.activeHigh + this.activeLow;
    if (total >= this.maxTotal) return false;
    if (priority === 'high') return this.activeHigh < this.maxHigh;
    return this.activeLow < this.maxLowNow();
  }
}
