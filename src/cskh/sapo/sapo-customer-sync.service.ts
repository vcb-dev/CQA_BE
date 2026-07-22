import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import { assertSapoReady, parseSapoDate, parseSapoTags } from './sapo-http.util';
import { isSapoApiReady } from './sapo-api.util';

type SapoCustomer = {
  id?: number;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  tags?: string | string[] | null;
  note?: string | null;
  created_on?: string | null;
};

export type SapoCustomerSyncResult = {
  source: 'sapo_api';
  fetched: number;
  inserted: number;
  updated: number;
  startPage: number;
};

@Injectable()
export class SapoCustomerSyncService {
  private readonly logger = new Logger(SapoCustomerSyncService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  isReady(): boolean {
    return isSapoApiReady(this.config);
  }

  /**
   * GET /admin/customers.json → customers.
   * Resume theo page đã sync (count/250), bulk insert KH mới, update nhanh theo sapo_id.
   */
  async syncFromSapo(): Promise<SapoCustomerSyncResult> {
    const { host, axiosCfg } = assertSapoReady(this.config);
    const url = `https://${host}/admin/customers.json`;

    const existingCount = await this.prisma.customer.count({
      where: { sapoId: { not: null } },
    });
    // Overlap 1 trang để an toàn nếu lần trước đứt giữa trang
    const startPage = Math.max(1, Math.floor(existingCount / 250));
    this.logger.log(
      `Customers sync resume: existing=${existingCount} startPage=${startPage}`,
    );

    // Cache sapo_id đã có — skip insert trùng
    const existingIds = new Set<number>(
      (
        await this.prisma.customer.findMany({
          where: { sapoId: { not: null } },
          select: { sapoId: true },
        })
      )
        .map((r) => Number(r.sapoId))
        .filter((n) => Number.isFinite(n) && n > 0),
    );
    this.logger.log(`Loaded ${existingIds.size} existing sapo customer ids`);

    let fetched = 0;
    let inserted = 0;
    const updated = 0;

    for (let page = startPage; page <= 500; page++) {
      const batch = await this.fetchPageWithRetry(url, axiosCfg, { limit: 250, page });
      if (!batch.length) break;
      fetched += batch.length;

      const rows = batch
        .filter((r) => r.id)
        .map((r) => ({
          sapoId: BigInt(r.id!),
          firstName: r.first_name?.trim() || null,
          lastName: r.last_name?.trim() || null,
          email: r.email?.trim() || null,
          phone: r.phone?.trim() || null,
          company: r.company?.trim() || null,
          tags: parseSapoTags(r.tags),
          note: r.note?.trim() || null,
          createdAt: parseSapoDate(r.created_on) ?? new Date(),
        }));

      const toInsert = rows.filter((r) => !existingIds.has(Number(r.sapoId)));
      // Chỉ insert KH mới — update lại toàn bộ 36k sẽ rất chậm; data cũ đã có rồi
      const skippedExisting = rows.length - toInsert.length;

      if (toInsert.length) {
        await this.prisma.customer.createMany({
          data: toInsert,
          skipDuplicates: true,
        });
        for (const r of toInsert) existingIds.add(Number(r.sapoId));
        inserted += toInsert.length;
      }

      this.logger.log(
        `Sapo customers page=${page} fetched=${fetched} inserted=${inserted} skippedExisting=${skippedExisting} known=${existingIds.size}`,
      );

      if (batch.length < 250) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    this.logger.log(
      `Sapo customers sync done: fetched=${fetched} inserted=${inserted} updated=${updated}`,
    );
    return { source: 'sapo_api', fetched, inserted, updated, startPage };
  }

  private async fetchPageWithRetry(
    url: string,
    axiosCfg: ReturnType<typeof assertSapoReady>['axiosCfg'],
    params: Record<string, number>,
    attempt = 1,
  ): Promise<SapoCustomer[]> {
    try {
      const { data } = await axios.get<{ customers?: SapoCustomer[] }>(url, {
        ...axiosCfg,
        params,
        timeout: 90_000,
      });
      return data.customers ?? [];
    } catch (e) {
      if (attempt >= 6) throw e;
      const wait = attempt * 2000;
      this.logger.warn(`customers fetch retry ${attempt} in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      return this.fetchPageWithRetry(url, axiosCfg, params, attempt + 1);
    }
  }
}
