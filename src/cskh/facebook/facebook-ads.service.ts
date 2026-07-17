import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { GRAPH_BASE } from './facebook-oauth.util';
import {
  extractPageIdFromCreative,
  extractPageIdFromPromotedObject,
  pageIdsMatch,
} from './cskh-ads-creative.util';

export type AdInsightsPayload = {
  adId: string;
  adName: string | null;
  adsetName: string | null;
  campaignName: string | null;
  currency: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  messagingConversations: number | null;
  costPerConversation: number | null;
  dateStart: string | null;
  dateStop: string | null;
  estimatedForThisConversation: number | null;
  localConversationCount: number;
  unavailableReason: string | null;
  /** true = không có ad_id, dùng chi phí TB Page (30 ngày) */
  isPageLevelEstimate?: boolean;
  /** @deprecated dùng isPageLevelEstimate */
  isAccountLevelEstimate?: boolean;
  /** ad = có mã QC; campaign = theo chiến dịch; adset = nhóm QC; page = TB theo Page */
  insightsScope?: 'ad' | 'campaign' | 'adset' | 'page' | null;
  estimateNote?: string | null;
  /** Tài khoản QC đã kết nối qua OAuth (để đối chiếu) */
  connectedAdAccountId?: string | null;
  connectedAdAccountName?: string | null;
  /** Camp QC đang chi tiêu nhiều (HEURISTIC / không ad_id) */
  topCampaigns?: Array<{
    campaignName: string;
    spend: number | null;
    messagingConversations: number | null;
  }>;
  /** ISO — thời điểm BE gọi Meta (hoặc trả từ cache RAM). */
  metaFetchedAt?: string | null;
  /** true = request có ?refresh=true, đã bỏ qua cache hội thoại. */
  refreshedFromMeta?: boolean;
};

type MetaActionRow = { action_type?: string; value?: string };

/**
 * Khớp Ads Manager cột "Lượt bắt đầu cuộc trò chuyện" — chỉ lấy 1 loại, không cộng nhiều action.
 * Thứ tự ưu tiên: 7d click (phổ biến nhất) → 1d → biến thể không prefix onsite_conversion.
 */
const MESSAGING_CONVERSATION_STARTED_TYPES = [
  'onsite_conversion.messaging_conversation_started_7d',
  'messaging_conversation_started_7d',
  'onsite_conversion.messaging_conversation_started_1d',
  'messaging_conversation_started_1d',
  'onsite_conversion.messaging_conversation_started',
  'messaging_conversation_started',
] as const;

type AdAccountRow = { id: string; name?: string; account_id?: string; currency?: string; account_status?: number };

/** Gợi ý QC của Page — lưu sau lần discover đầu để lần sau chỉ 1 API insights. */
export type PageAdHint = {
  adAccountId: string;
  adAccountName: string | null;
  adsetId: string | null;
  campaignId: string | null;
  adsetName: string | null;
  campaignName: string | null;
};

type AccountEstimateResult = {
  currency: string | null;
  spend: number | null;
  messagingConversations: number | null;
  costPerConversation: number | null;
  dateStart: string | null;
  dateStop: string | null;
  adAccountId: string | null;
  adAccountName: string | null;
  campaignName: string | null;
  campaignId: string | null;
  adName: string | null;
  adsetName: string | null;
  adsetId: string | null;
  topCampaigns: Array<{
    campaignName: string;
    spend: number | null;
    messagingConversations: number | null;
  }>;
};

@Injectable()
export class FacebookAdsService {
  private readonly logger = new Logger(FacebookAdsService.name);
  private readonly cache = new Map<string, { at: number; data: Omit<AdInsightsPayload, 'estimatedForThisConversation' | 'localConversationCount' | 'unavailableReason'> }>();
  private readonly cacheTtlMs = Number(process.env.CSKH_AD_INSIGHTS_CACHE_MS || 3_600_000);
  private readonly pageAccountFilterCache = new Map<string, { at: number; accounts: AdAccountRow[] }>();
  private readonly pageAccountFilterCacheTtlMs = 3_600_000;
  /** Cache Page → adset QC (sau lần tra đầu, chỉ cần 1 request insights). */
  private readonly pageAdHintCache = new Map<string, { at: number; hint: PageAdHint }>();
  private readonly pageAdHintTtlMs = Number(process.env.CSKH_PAGE_AD_HINT_CACHE_MS || 21_600_000);
  /** Tránh gọi lại listAds khi Meta trả 400 liên tục (rate / param). */
  private listAdsBrokenUntil = new Map<string, number>();
  /** Meta ads-management rate limit theo tài khoản QC (80004). */
  private accountRateLimitedUntil = new Map<string, number>();
  /** Meta app/user rate limit (17 — User request limit reached). */
  private graphUserRateLimitedUntil = 0;
  private graphAdsInflight = 0;
  private readonly graphAdsMaxInflight = Number(process.env.CSKH_GRAPH_ADS_MAX_INFLIGHT || 2);
  private graphAdsWaitQueue: Array<() => void> = [];
  /** Không gọi lại discover khi đã biết Page không có QC trên tài khoản này. */
  private readonly discoverMissUntil = new Map<string, number>();
  private readonly discoverMissTtlMs = Number(process.env.CSKH_PAGE_AD_DISCOVER_MISS_MS || 21_600_000);
  private readonly discoverInflight = new Map<string, Promise<PageAdHint | null>>();
  private adsetPageFilterSupported: boolean | null = null;

  private discoverKey(accountId: string, pageId: string): string {
    return `${accountId}:${pageId}`;
  }

  private isUnsupportedAdsFilterError(e: unknown): boolean {
    const msg = this.graphErrorMessage(e);
    return /Filtering field .* is not supported|not supported/i.test(msg);
  }

  private graphErrorMessage(e: unknown): string {
    if (axios.isAxiosError(e)) {
      const meta = (e.response?.data as { error?: { message?: string; code?: number } })?.error;
      if (meta?.message) return `[${meta.code ?? e.response?.status}] ${meta.message}`;
      return e.message;
    }
    return (e as Error).message;
  }

  private isRateLimitError(e: unknown): boolean {
    const msg = this.graphErrorMessage(e);
    return /\[80004\]|too many calls|rate limit/i.test(msg);
  }

  private isUserRateLimitError(e: unknown): boolean {
    const msg = this.graphErrorMessage(e);
    return /\[17\]|User request limit reached/i.test(msg);
  }

  isGraphUserRateLimited(): boolean {
    return Date.now() < this.graphUserRateLimitedUntil;
  }

  private markUserRateLimited(minutes = 20): void {
    this.graphUserRateLimitedUntil = Date.now() + minutes * 60_000;
    this.logger.warn(`Meta user/app rate limit — tạm dừng ads API ~${minutes} phút`);
  }

  getPageAdHint(pageId: string): PageAdHint | null {
    const row = this.pageAdHintCache.get(pageId);
    if (!row || Date.now() - row.at > this.pageAdHintTtlMs) return null;
    return row.hint;
  }

  savePageAdHint(pageId: string, hint: PageAdHint): void {
    this.pageAdHintCache.set(pageId, { at: Date.now(), hint });
    const accKey = `${pageId}:${hint.adAccountId}`;
    this.pageAccountFilterCache.set(accKey, {
      at: Date.now(),
      accounts: [{ id: hint.adAccountId, name: hint.adAccountName ?? undefined }],
    });
  }

  /** Ưu tiên tài khoản QC đã biết — khi có adset_id chỉ thử 1 tài khoản. */
  orderAccountsForPage(pageId: string, accounts: AdAccountRow[], max = 2): AdAccountRow[] {
    const hint = this.getPageAdHint(pageId);
    if (!hint?.adAccountId) return accounts.filter((a) => a.id).slice(0, max);
    const hit = accounts.filter((a) => a.id === hint.adAccountId);
    if (hint.adsetId && hit.length) return hit.slice(0, 1);
    return [
      ...hit,
      ...accounts.filter((a) => a.id && a.id !== hint.adAccountId),
    ].slice(0, max);
  }

  isAccountRateLimited(adAccountId: string): boolean {
    return Date.now() < (this.accountRateLimitedUntil.get(adAccountId) ?? 0);
  }

  private markAccountRateLimited(adAccountId: string, minutes = 30): void {
    this.accountRateLimitedUntil.set(adAccountId, Date.now() + minutes * 60_000);
    this.logger.warn(`Meta ads rate limit — tạm dừng ${adAccountId} ~${minutes} phút`);
  }

  private async acquireGraphAdsSlot(): Promise<void> {
    if (this.graphAdsInflight < this.graphAdsMaxInflight) {
      this.graphAdsInflight++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.graphAdsWaitQueue.push(() => {
        this.graphAdsInflight++;
        resolve();
      });
    });
  }

  private releaseGraphAdsSlot(): void {
    this.graphAdsInflight = Math.max(0, this.graphAdsInflight - 1);
    const next = this.graphAdsWaitQueue.shift();
    if (next) next();
  }

  /** Giới hạn song song + backoff khi Meta trả 80004. */
  private async graphGet<T>(
    adAccountId: string | null,
    url: string,
    params: Record<string, string | number>,
    timeoutMs: number,
  ): Promise<T> {
    if (adAccountId && this.isAccountRateLimited(adAccountId)) {
      throw new Error(`[rate_limited] account ${adAccountId} paused`);
    }
    if (this.isGraphUserRateLimited()) {
      throw new Error('[rate_limited] user/app paused');
    }
    await this.acquireGraphAdsSlot();
    try {
      const res = await axios.get(url, { params, timeout: timeoutMs });
      return res.data as T;
    } catch (e) {
      if (this.isUserRateLimitError(e)) {
        this.markUserRateLimited();
      }
      if (adAccountId && this.isRateLimitError(e)) {
        this.markAccountRateLimited(adAccountId);
      }
      throw e;
    } finally {
      this.releaseGraphAdsSlot();
    }
  }

  private isListAdsBroken(adAccountId: string, pageId: string): boolean {
    const until = this.listAdsBrokenUntil.get(`${adAccountId}:${pageId}`) ?? 0;
    return Date.now() < until;
  }

  private markListAdsBroken(adAccountId: string, pageId: string, minutes = 15): void {
    this.listAdsBrokenUntil.set(`${adAccountId}:${pageId}`, Date.now() + minutes * 60_000);
    if (minutes >= 30) {
      this.markAccountRateLimited(adAccountId, minutes);
    }
  }

  /** Lấy đúng 1 metric messaging (không cộng dồn) — khớp Ads Manager. */
  private pickMessagingMetric(
    actions: MetaActionRow[] | undefined,
    preferredTypes: readonly string[] = MESSAGING_CONVERSATION_STARTED_TYPES,
  ): number | null {
    if (!Array.isArray(actions)) return null;
    for (const preferred of preferredTypes) {
      for (const row of actions) {
        if (row.action_type !== preferred) continue;
        const n = Number(row.value);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    return null;
  }

  private parseMessagingConversationCount(actions: MetaActionRow[] | undefined): number | null {
    return this.pickMessagingMetric(actions);
  }

  private parseMessagingConversationCost(costPerAction: MetaActionRow[] | undefined): number | null {
    return this.pickMessagingMetric(costPerAction);
  }

  private resolveMessagingInsights(
    row: Record<string, unknown>,
    spend: number,
  ): { messagingConversations: number | null; costPerConversation: number | null } {
    const actions = row.actions as MetaActionRow[] | undefined;
    const costPerAction = row.cost_per_action_type as MetaActionRow[] | undefined;

    const messagingConversations =
      this.parseMessagingConversationCount(actions) ??
      this.parseMessagingConversationCount(costPerAction);

    let costPerConversation = this.parseMessagingConversationCost(costPerAction);
    if (costPerConversation != null) {
      return { messagingConversations, costPerConversation };
    }
    if (
      Number.isFinite(spend) &&
      spend > 0 &&
      messagingConversations != null &&
      messagingConversations > 0
    ) {
      costPerConversation = spend / messagingConversations;
    }

    return { messagingConversations, costPerConversation };
  }

  private formatDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /** 30 ngày lịch VN (gồm hôm nay) — khớp Ads Manager khi xem đến ngày hiện tại. */
  private insightsTimeRangeVn(): { since: string; until: string } {
    const until = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
      new Date(),
    );
    const since = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
      new Date(Date.now() - 29 * 86_400_000),
    );
    return { since, until };
  }

  private applyInsightsTimeRange(
    params: Record<string, string | number>,
    since?: string,
    until?: string,
  ): void {
    if (since && until) {
      params.time_range = JSON.stringify({ since, until });
      return;
    }
    const range = this.insightsTimeRangeVn();
    params.time_range = JSON.stringify(range);
  }

  /**
   * Insights theo cấp campaign/adset — khớp cột Ads Manager (không cộng tay từng ad).
   */
  private async fetchLevelMessagingInsights(
    account: AdAccountRow,
    level: 'campaign' | 'adset',
    filter:
      | { field: 'campaign.id' | 'campaign.name' | 'adset.id' | 'adset.name'; value: string },
    userAccessToken: string,
    opts?: { since?: string; until?: string; bypassCache?: boolean },
  ): Promise<AccountEstimateResult | null> {
    if (!account.id || !filter.value.trim()) return null;
    const rangeKey =
      opts?.since && opts?.until ? `${opts.since}:${opts.until}` : this.insightsTimeRangeVn();
    const rangeLabel =
      typeof rangeKey === 'string' ? rangeKey : `${rangeKey.since}:${rangeKey.until}`;
    const cacheKey = `level-messaging:v1:${level}:${account.id}:${filter.field}:${filter.value}:${rangeLabel}`;
    if (opts?.bypassCache) {
      this.cache.delete(cacheKey);
    } else {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.at < this.cacheTtlMs) {
        return cached.data as unknown as AccountEstimateResult;
      }
    }

    const fields =
      level === 'campaign'
        ? 'campaign_id,campaign_name,spend,actions,cost_per_action_type,account_currency,date_start,date_stop'
        : 'adset_id,adset_name,campaign_id,campaign_name,spend,actions,cost_per_action_type,account_currency,date_start,date_stop';

    const params: Record<string, string | number> = {
      level,
      fields,
      filtering: JSON.stringify([{ field: filter.field, operator: 'EQUAL', value: filter.value }]),
      limit: 5,
      access_token: userAccessToken,
    };
    if (opts?.since && opts?.until) {
      this.applyInsightsTimeRange(params, opts.since, opts.until);
    } else {
      this.applyInsightsTimeRange(params);
    }

    let insightRows: Array<Record<string, unknown>> = [];
    try {
      const res = await this.graphGet<{ data?: Array<Record<string, unknown>> }>(
        account.id,
        `${GRAPH_BASE}/${account.id}/insights`,
        params,
        20_000,
      );
      insightRows = Array.isArray(res?.data) ? res.data : [];
    } catch (e) {
      this.logger.warn(
        `fetchLevelMessagingInsights ${level} account=${account.id} ${filter.field}=${filter.value.slice(0, 40)}: ${this.graphErrorMessage(e)}`,
      );
      return null;
    }

    if (!insightRows.length) return null;

    const row = insightRows[0];
    const parsed = this.parseInsightsRow(row);
    if (parsed.spend <= 0 && parsed.messagingConversations == null) return null;

    const result: AccountEstimateResult = {
      currency: (row.account_currency as string | undefined) ?? account.currency ?? null,
      spend: parsed.spend > 0 ? parsed.spend : null,
      messagingConversations: parsed.messagingConversations,
      costPerConversation: parsed.costPerConversation,
      dateStart: (row.date_start as string | undefined) ?? null,
      dateStop: (row.date_stop as string | undefined) ?? null,
      adAccountId: account.id,
      adAccountName: account.name ?? null,
      campaignName: (row.campaign_name as string | undefined) ?? null,
      campaignId: (row.campaign_id as string | undefined) ?? null,
      adName: null,
      adsetName: (row.adset_name as string | undefined) ?? null,
      adsetId: (row.adset_id as string | undefined) ?? null,
      topCampaigns: [],
    };

    this.cache.set(cacheKey, {
      at: Date.now(),
      data: result as unknown as Omit<
        AdInsightsPayload,
        'estimatedForThisConversation' | 'localConversationCount' | 'unavailableReason'
      >,
    });
    return result;
  }

  async fetchAdInsights(
    adId: string,
    userAccessToken: string,
    opts?: { since?: Date; until?: Date; bypassCache?: boolean },
  ): Promise<Omit<AdInsightsPayload, 'estimatedForThisConversation' | 'localConversationCount' | 'unavailableReason'>> {
    const since = opts?.since ? this.formatDate(opts.since) : null;
    const until = opts?.until ? this.formatDate(opts.until) : null;
    const cacheKey = `${adId}:v2:${since ?? 'default'}:${until ?? 'default'}`;
    if (!opts?.bypassCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.at < this.cacheTtlMs) {
        return cached.data;
      }
    }

    const params: Record<string, string> = {
      fields:
        'spend,impressions,clicks,actions,cost_per_action_type,campaign_name,adset_name,ad_name,account_currency,date_start,date_stop',
      access_token: userAccessToken,
    };
    if (since && until) {
      params.time_range = JSON.stringify({ since, until });
    } else {
      const range = this.insightsTimeRangeVn();
      params.time_range = JSON.stringify(range);
    }

    try {
      const res = await axios.get(`${GRAPH_BASE}/${adId}/insights`, {
        params,
        timeout: 30_000,
      });
      const row = Array.isArray(res.data?.data) ? res.data.data[0] : null;
      if (!row) {
        return {
          adId,
          adName: null,
          adsetName: null,
          campaignName: null,
          currency: null,
          spend: null,
          impressions: null,
          clicks: null,
          messagingConversations: null,
          costPerConversation: null,
          dateStart: since,
          dateStop: until,
        };
      }

      const spend = row.spend != null ? Number(row.spend) : null;
      const spendNum = spend != null && Number.isFinite(spend) ? spend : 0;
      const { messagingConversations, costPerConversation } = this.resolveMessagingInsights(row, spendNum);

      const payload = {
        adId,
        adName: (row.ad_name as string | undefined) ?? null,
        adsetName: (row.adset_name as string | undefined) ?? null,
        campaignName: (row.campaign_name as string | undefined) ?? null,
        currency: (row.account_currency as string | undefined) ?? null,
        spend: Number.isFinite(spend) ? spend : null,
        impressions: row.impressions != null ? Number(row.impressions) : null,
        clicks: row.clicks != null ? Number(row.clicks) : null,
        messagingConversations,
        costPerConversation,
        dateStart: (row.date_start as string | undefined) ?? since,
        dateStop: (row.date_stop as string | undefined) ?? until,
      };
      this.cache.set(cacheKey, { at: Date.now(), data: payload });
      return payload;
    } catch (e) {
      const msg = this.graphErrorMessage(e);
      this.logger.warn(`fetchAdInsights ad=${adId}: ${msg}`);
      throw new Error(msg);
    }
  }

  /** Tài khoản QC của Page — dùng cache hint, không gọi API quét ads. */
  async filterAdAccountsForPage(
    pageId: string,
    _userAccessToken: string,
    accounts: AdAccountRow[],
  ): Promise<AdAccountRow[]> {
    if (!pageId || !accounts.length) return [];

    const hint = this.getPageAdHint(pageId);
    if (hint?.adAccountId) {
      const hit = accounts.find((a) => a.id === hint.adAccountId);
      if (hit) return [hit];
    }

    const cacheKey = `${pageId}:${accounts.slice(0, 5).map((a) => a.id).join(',')}`;
    const cached = this.pageAccountFilterCache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.pageAccountFilterCacheTtlMs) {
      return cached.accounts;
    }

    // Không quét assigned_pages / listAds — trả rỗng, caller dùng fetchPageAdInsightsFast
    this.pageAccountFilterCache.set(cacheKey, { at: Date.now(), accounts: [] });
    return [];
  }

  private parseAdRowAsPageHint(
    account: AdAccountRow,
    pageId: string,
    row: Record<string, unknown>,
  ): PageAdHint | null {
    const creative = row.creative as Record<string, unknown> | undefined;
    const adset = row.adset as Record<string, unknown> | undefined;
    const campaign = row.campaign as Record<string, unknown> | undefined;
    const pageMatch =
      pageIdsMatch(extractPageIdFromCreative(creative), pageId) ||
      pageIdsMatch(extractPageIdFromPromotedObject(adset), pageId);
    if (!pageMatch) return null;
    const adsetId = (adset?.id as string | undefined) ?? null;
    if (!adsetId) return null;
    return {
      adAccountId: account.id,
      adAccountName: account.name ?? null,
      adsetId,
      campaignId: (campaign?.id as string | undefined) ?? null,
      adsetName: (adset?.name as string | undefined) ?? null,
      campaignName: (campaign?.name as string | undefined) ?? null,
    };
  }

  /** 1 request adsets/ads — lấy adset_id QC của Page (không dùng filter Meta không hỗ trợ). */
  private async discoverPageAdsetHint(
    account: AdAccountRow,
    pageId: string,
    userAccessToken: string,
  ): Promise<PageAdHint | null> {
    if (!account.id || this.isAccountRateLimited(account.id) || this.isGraphUserRateLimited()) {
      return null;
    }

    const key = this.discoverKey(account.id, pageId);
    const missUntil = this.discoverMissUntil.get(key) ?? 0;
    if (Date.now() < missUntil) return null;

    const inflight = this.discoverInflight.get(key);
    if (inflight) return inflight;

    const task = this.discoverPageAdsetHintOnce(account, pageId, userAccessToken);
    this.discoverInflight.set(key, task);
    try {
      const hint = await task;
      if (!hint) {
        this.discoverMissUntil.set(key, Date.now() + this.discoverMissTtlMs);
      }
      return hint;
    } finally {
      this.discoverInflight.delete(key);
    }
  }

  private hintFromAdsetRow(
    account: AdAccountRow,
    pageId: string,
    adset: Record<string, unknown>,
  ): PageAdHint | null {
    const po = adset.promoted_object as Record<string, unknown> | undefined;
    if (!pageIdsMatch(po?.page_id, pageId)) return null;
    const adsetId = (adset.id as string | undefined) ?? null;
    if (!adsetId) return null;
    const campaign = adset.campaign as Record<string, unknown> | undefined;
    return {
      adAccountId: account.id,
      adAccountName: account.name ?? null,
      adsetId,
      campaignId: (campaign?.id as string | undefined) ?? null,
      adsetName: (adset.name as string | undefined) ?? null,
      campaignName: (campaign?.name as string | undefined) ?? null,
    };
  }

  private async discoverPageAdsetHintOnce(
    account: AdAccountRow,
    pageId: string,
    userAccessToken: string,
  ): Promise<PageAdHint | null> {
    const statusIn = {
      field: 'effective_status',
      operator: 'IN',
      value: ['ACTIVE', 'PAUSED'],
    };

    if (this.adsetPageFilterSupported !== false) {
      try {
        const adsetRes = await this.graphGet<{ data?: Array<Record<string, unknown>> }>(
          account.id,
          `${GRAPH_BASE}/${account.id}/adsets`,
          {
            fields: 'id,name,promoted_object,campaign{id,name}',
            limit: 5,
            filtering: JSON.stringify([
              statusIn,
              { field: 'promoted_object.page_id', operator: 'EQUAL', value: pageId },
            ]),
            access_token: userAccessToken,
          },
          15_000,
        );
        this.adsetPageFilterSupported = true;
        for (const row of adsetRes?.data ?? []) {
          const hint = this.hintFromAdsetRow(account, pageId, row);
          if (hint) return hint;
        }
      } catch (e) {
        if (this.isUnsupportedAdsFilterError(e)) {
          this.adsetPageFilterSupported = false;
        } else {
          this.logger.debug(
            `discoverPageAdsetHint adsets-filter ${account.id} page=${pageId}: ${this.graphErrorMessage(e)}`,
          );
        }
      }
    }

    try {
      const res = await this.graphGet<{ data?: Array<Record<string, unknown>> }>(
        account.id,
        `${GRAPH_BASE}/${account.id}/ads`,
        {
          fields:
            'id,adset{id,name,promoted_object},campaign{id,name},creative{object_story_spec}',
          limit: 50,
          filtering: JSON.stringify([
            { field: 'ad.effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] },
          ]),
          access_token: userAccessToken,
        },
        20_000,
      );
      for (const row of res?.data ?? []) {
        const hint = this.parseAdRowAsPageHint(account, pageId, row);
        if (hint) return hint;
      }
    } catch (e) {
      this.logger.debug(
        `discoverPageAdsetHint ads-scan ${account.id} page=${pageId}: ${this.graphErrorMessage(e)}`,
      );
    }

    return null;
  }

  /**
   * Đường nhanh: cache hint → 1 API insights; lần đầu → discover (1) + insights (1).
   * Không quét assigned_pages / listAdsForPage / cộng từng ad.
   */
  async fetchPageAdInsightsFast(
    pageId: string,
    accounts: AdAccountRow[],
    userAccessToken: string,
    opts?: { since?: string; until?: string; bypassCache?: boolean },
  ): Promise<AccountEstimateResult | null> {
    if (!pageId || !accounts.length) return null;
    if (this.isGraphUserRateLimited()) return null;

    const tryHint = async (hint: PageAdHint): Promise<AccountEstimateResult | null> => {
      const est = await this.fetchAdsetMessagingInsights(
        { id: hint.adAccountId, name: hint.adAccountName ?? undefined },
        { adsetId: hint.adsetId, adsetName: hint.adsetName },
        userAccessToken,
        opts,
      );
      if (est?.spend != null && est.spend > 0) return est;
      if (hint.campaignId || hint.campaignName) {
        return this.fetchCampaignMessagingInsights(
          { id: hint.adAccountId, name: hint.adAccountName ?? undefined },
          { campaignId: hint.campaignId, campaignName: hint.campaignName },
          userAccessToken,
          opts?.bypassCache === true,
          opts,
        );
      }
      return est;
    };

    const cachedHint = this.getPageAdHint(pageId);
    if (cachedHint) {
      const est = await tryHint(cachedHint);
      if (opts?.bypassCache) return est;
      if (est?.spend != null && est.spend > 0) return est;
    }

    if (opts?.bypassCache) return null;

    const ordered = this.orderAccountsForPage(pageId, accounts, 3);
    const maxTry = Math.min(
      ordered.length,
      Number(process.env.CSKH_ADS_FAST_ACCOUNT_TRY || 3),
    );
    for (const account of ordered.slice(0, maxTry)) {
      if (!account.id || this.isAccountRateLimited(account.id)) continue;
      const hint = await this.discoverPageAdsetHint(account, pageId, userAccessToken);
      if (!hint) continue;
      this.savePageAdHint(pageId, hint);
      const est = await tryHint(hint);
      if (est?.spend != null && est.spend > 0) return est;
    }
    return null;
  }

  async fetchAdAccounts(userAccessToken: string) {
    const accounts: AdAccountRow[] = [];
    let nextUrl: string | null = `${GRAPH_BASE}/me/adaccounts`;
    let useParams = true;
    const params: Record<string, string | number> = {
      fields: 'id,name,account_id,currency,account_status',
      limit: 100,
      access_token: userAccessToken,
    };

    while (nextUrl) {
      const res = await axios.get(nextUrl, {
        params: useParams ? params : undefined,
        timeout: 30_000,
      });
      useParams = false;
      if (Array.isArray(res.data?.data)) accounts.push(...res.data.data);
      nextUrl = res.data?.paging?.next ?? null;
    }
    return accounts;
  }

  private parseInsightsRow(row: Record<string, unknown>): {
    spend: number;
    messagingConversations: number | null;
    costPerConversation: number | null;
  } {
    const spend = row.spend != null ? Number(row.spend) : 0;
    const { messagingConversations, costPerConversation } = this.resolveMessagingInsights(row, spend);
    return {
      spend: Number.isFinite(spend) ? spend : 0,
      messagingConversations,
      costPerConversation,
    };
  }

  private async fetchAccountInsightsRow(
    account: AdAccountRow,
    userAccessToken: string,
    _preset: string,
  ): Promise<Record<string, unknown> | null> {
    const params: Record<string, string> = {
      fields: 'spend,actions,cost_per_action_type,account_currency,date_start,date_stop',
      access_token: userAccessToken,
    };
    this.applyInsightsTimeRange(params);
    const res = await axios.get(`${GRAPH_BASE}/${account.id}/insights`, {
      params,
      timeout: 12_000,
    });
    return Array.isArray(res.data?.data)
      ? (res.data.data[0] as Record<string, unknown> | undefined) ?? null
      : null;
  }

  /** Top campaign theo spend/messaging trên ad account (Insights level=campaign). */
  async fetchTopCampaignInsights(
    adAccountId: string,
    userAccessToken: string,
    limit = 5,
  ): Promise<
    Array<{
      campaignName: string;
      spend: number | null;
      messagingConversations: number | null;
    }>
  > {
    const cacheKey = `top-campaigns:${adAccountId}:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      const rows = (cached.data as { topCampaigns?: AccountEstimateResult['topCampaigns'] }).topCampaigns;
      return rows ?? [];
    }

    try {
      const res = await axios.get(`${GRAPH_BASE}/${adAccountId}/insights`, {
        params: {
          level: 'campaign',
          fields: 'campaign_name,spend,actions,cost_per_action_type',
          date_preset: 'last_30d',
          sort: 'spend_descending',
          limit,
          access_token: userAccessToken,
        },
        timeout: 25_000,
      });
      const rows = Array.isArray(res.data?.data) ? res.data.data : [];
      const topCampaigns = rows
        .map((row: Record<string, unknown>) => {
          const name = (row.campaign_name as string | undefined)?.trim();
          if (!name) return null;
          const spend = row.spend != null ? Number(row.spend) : null;
          const spendNum = spend != null && Number.isFinite(spend) ? spend : 0;
          const messagingConversations = this.parseMessagingConversationCount(
            row.actions as MetaActionRow[],
          ) ?? this.parseMessagingConversationCount(row.cost_per_action_type as MetaActionRow[]);
          return {
            campaignName: name,
            spend: Number.isFinite(spend) ? spend : null,
            messagingConversations,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r != null);

      this.cache.set(cacheKey, {
        at: Date.now(),
        data: { topCampaigns } as unknown as Omit<
          AdInsightsPayload,
          'estimatedForThisConversation' | 'localConversationCount' | 'unavailableReason'
        >,
      });
      return topCampaigns;
    } catch (e) {
      this.logger.warn(
        `fetchTopCampaignInsights account=${adAccountId}: ${(e as Error).message}`,
      );
      return [];
    }
  }

  /** QC của Page — ưu tiên quét ads (1 request), fallback adset Click-to-Messenger. */
  private async listAdsForPage(
    adAccountId: string,
    pageId: string,
    userAccessToken: string,
    limit = 80,
  ): Promise<
    Array<{
      id: string;
      name: string | null;
      campaignName: string | null;
      adsetName: string | null;
    }>
  > {
    if (!pageId) return [];
    if (this.isListAdsBroken(adAccountId, pageId) || this.isAccountRateLimited(adAccountId)) {
      return [];
    }

    const cacheKey = `page-ads:${adAccountId}:${pageId}:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      const rows = (cached.data as { pageAds?: Array<{ id: string; name: string | null; campaignName: string | null; adsetName: string | null }> })
        .pageAds;
      return rows ?? [];
    }

    const pageAds: Array<{
      id: string;
      name: string | null;
      campaignName: string | null;
      adsetName: string | null;
    }> = [];
    const seen = new Set<string>();
    let hardFail = false;

    const noteFail = (e: unknown) => {
      const msg = this.graphErrorMessage(e);
      if (this.isRateLimitError(e)) {
        hardFail = true;
        this.markListAdsBroken(adAccountId, pageId, 30);
      } else if (/400|Invalid parameter/i.test(msg)) {
        hardFail = true;
      }
      return msg;
    };

    const pushAd = (row: Record<string, unknown>, adsetName?: string | null) => {
      if (pageAds.length >= limit) return;
      const status = String(row.effective_status ?? '');
      if (status && !['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'].includes(status)) {
        return;
      }
      const id = String(row.id ?? '');
      if (!id || seen.has(id)) return;
      const campaign = row.campaign as { name?: string } | undefined;
      const adset = row.adset as { name?: string } | undefined;
      seen.add(id);
      pageAds.push({
        id,
        name: (row.name as string | undefined) ?? null,
        campaignName: campaign?.name ?? null,
        adsetName: adsetName ?? adset?.name ?? null,
      });
    };

    // 1) Một request — ads + creative / adset promoted_object (nhẹ nhất)
    try {
      const res = await this.graphGet<{ data?: Array<Record<string, unknown>> }>(
        adAccountId,
        `${GRAPH_BASE}/${adAccountId}/ads`,
        {
          fields:
            'id,name,effective_status,campaign{id,name},adset{id,name,promoted_object},creative{object_story_spec}',
          limit: 150,
          filtering: JSON.stringify([
            { field: 'ad.effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] },
          ]),
          access_token: userAccessToken,
        },
        25_000,
      );
      const rows = Array.isArray(res?.data) ? res.data : [];
      for (const row of rows) {
        if (pageAds.length >= limit) break;
        const creative = row.creative as Record<string, unknown> | undefined;
        const adset = row.adset as Record<string, unknown> | undefined;
        const pageMatch =
          pageIdsMatch(extractPageIdFromCreative(creative), pageId) ||
          pageIdsMatch(extractPageIdFromPromotedObject(adset), pageId);
        if (!pageMatch) continue;
        pushAd(row);
      }
    } catch (e) {
      const msg = noteFail(e);
      this.logger.warn(`listAdsForPage ads account=${adAccountId} page=${pageId}: ${msg}`);
    }

    // 2) Ad sets Click-to-Messenger — chỉ khi bước 1 không tìm thấy QC nào
    if (pageAds.length === 0 && !this.isAccountRateLimited(adAccountId) && !this.isGraphUserRateLimited()) {
      try {
        const adsetRes = await this.graphGet<{ data?: Array<Record<string, unknown>> }>(
          adAccountId,
          `${GRAPH_BASE}/${adAccountId}/adsets`,
          {
            fields: 'id,name,promoted_object,effective_status',
            limit: 100,
            filtering: JSON.stringify([
              { field: 'adset.effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] },
            ]),
            access_token: userAccessToken,
          },
          25_000,
        );
        const adsets = Array.isArray(adsetRes?.data) ? adsetRes.data : [];
        for (const adset of adsets) {
          if (pageAds.length >= limit) break;
          const po = adset.promoted_object as Record<string, unknown> | undefined;
          if (!pageIdsMatch(po?.page_id, pageId)) continue;
          const adsetId = String(adset.id ?? '');
          if (!adsetId) continue;
          try {
            const adsRes = await this.graphGet<{ data?: Array<Record<string, unknown>> }>(
              adAccountId,
              `${GRAPH_BASE}/${adsetId}/ads`,
              {
                fields: 'id,name,effective_status,campaign{id,name},adset{id,name}',
                limit: 50,
                filtering: JSON.stringify([
                  { field: 'ad.effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] },
                ]),
                access_token: userAccessToken,
              },
              15_000,
            );
            for (const ad of adsRes?.data ?? []) {
              pushAd(ad, (adset.name as string | undefined) ?? null);
            }
          } catch (e) {
            this.logger.debug(
              `listAdsForPage adset-ads ${adsetId} page=${pageId}: ${this.graphErrorMessage(e)}`,
            );
          }
        }
      } catch (e) {
        const msg = noteFail(e);
        this.logger.debug(`listAdsForPage adsets account=${adAccountId} page=${pageId}: ${msg}`);
      }
    }

    if (hardFail && !pageAds.length) {
      this.markListAdsBroken(adAccountId, pageId);
    }

    this.cache.set(cacheKey, {
      at: Date.now(),
      data: { pageAds } as unknown as Omit<
        AdInsightsPayload,
        'estimatedForThisConversation' | 'localConversationCount' | 'unavailableReason'
      >,
    });
    return pageAds;
  }

  /** Số QC đang chạy cho Page trên tài khoản này (debug / chọn OAuth). */
  async countPageAds(
    adAccountId: string,
    pageId: string,
    userAccessToken: string,
  ): Promise<number> {
    const ads = await this.listAdsForPage(adAccountId, pageId, userAccessToken, 10);
    return ads.length;
  }

  /**
   * Chi phí messaging tổng hợp từ các QC của **Page này** (30 ngày) — không phải toàn tài khoản QC.
   */
  async fetchPageMessagingInsights(
    account: AdAccountRow,
    pageId: string,
    userAccessToken: string,
    opts?: { since?: string; until?: string; bypassCache?: boolean },
  ): Promise<AccountEstimateResult | null> {
    if (!pageId || !account.id) return null;
    const since = opts?.since?.trim();
    const until = opts?.until?.trim();
    const rangeKey = since && until ? `${since}:${until}` : 'last_30d';
    const cacheKey = `page-messaging:v3:${account.id}:${pageId}:${rangeKey}`;
    if (!opts?.bypassCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.at < this.cacheTtlMs) {
        return cached.data as unknown as AccountEstimateResult;
      }
    }

    const pageAds = await this.listAdsForPage(account.id, pageId, userAccessToken);
    if (!pageAds.length) return null;

    const adIds = pageAds.map((a) => a.id);
    let insightRows: Array<Record<string, unknown>> = [];
    try {
      const batchSize = 50;
      for (let i = 0; i < adIds.length; i += batchSize) {
        const batch = adIds.slice(i, i + batchSize);
        const insightParams: Record<string, string | number> = {
          level: 'ad',
          fields:
            'ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,spend,actions,cost_per_action_type,account_currency,date_start,date_stop',
          filtering: JSON.stringify([{ field: 'ad.id', operator: 'IN', value: batch }]),
          limit: 100,
          access_token: userAccessToken,
        };
        if (since && until) {
          this.applyInsightsTimeRange(insightParams, since, until);
        } else {
          this.applyInsightsTimeRange(insightParams);
        }
        const res = await this.graphGet<{ data?: Array<Record<string, unknown>> }>(
          account.id,
          `${GRAPH_BASE}/${account.id}/insights`,
          insightParams,
          20_000,
        );
        if (Array.isArray(res?.data)) insightRows.push(...res.data);
      }
    } catch (e) {
      const msg = this.graphErrorMessage(e);
      this.logger.warn(
        `fetchPageMessagingInsights account=${account.id} page=${pageId}: ${msg}`,
      );
      return null;
    }

    if (!insightRows.length) return null;

    let totalSpend = 0;
    let totalMessaging = 0;
    let bestAdId: string | null = null;
    let bestMessaging = 0;
    let bestRow: Record<string, unknown> | null = null;

    for (const row of insightRows) {
      const parsed = this.parseInsightsRow(row);
      totalSpend += parsed.spend;
      const msg = parsed.messagingConversations ?? 0;
      totalMessaging += msg;
      const adId = String(row.ad_id ?? '');
      if (msg > bestMessaging) {
        bestMessaging = msg;
        bestAdId = adId || null;
        bestRow = row;
      }
    }

    const bestAdMeta = bestAdId ? pageAds.find((a) => a.id === bestAdId) : null;
    const firstRow = insightRows[0];
    const costPerConversation =
      totalMessaging > 0 && totalSpend > 0 ? totalSpend / totalMessaging : null;

    const result: AccountEstimateResult = {
      currency: (firstRow.account_currency as string | undefined) ?? account.currency ?? null,
      spend: totalSpend > 0 ? totalSpend : null,
      messagingConversations: totalMessaging > 0 ? totalMessaging : null,
      costPerConversation,
      dateStart: (firstRow.date_start as string | undefined) ?? null,
      dateStop: (firstRow.date_stop as string | undefined) ?? null,
      adAccountId: account.id,
      adAccountName: account.name ?? null,
      campaignName:
        (bestRow?.campaign_name as string | undefined) ?? bestAdMeta?.campaignName ?? null,
      campaignId: (bestRow?.campaign_id as string | undefined) ?? null,
      adName: bestAdMeta?.name ?? null,
      adsetName: (bestRow?.adset_name as string | undefined) ?? bestAdMeta?.adsetName ?? null,
      adsetId: (bestRow?.adset_id as string | undefined) ?? null,
      topCampaigns: [],
    };

    this.cache.set(cacheKey, {
      at: Date.now(),
      data: result as unknown as Omit<
        AdInsightsPayload,
        'estimatedForThisConversation' | 'localConversationCount' | 'unavailableReason'
      >,
    });
    return result;
  }

  /**
   * Chi phí messaging theo **nhóm QC (ad set)** — khớp tab Nhóm quảng cáo trên Ads Manager.
   */
  async fetchAdsetMessagingInsights(
    account: AdAccountRow,
    adsetRef: { adsetId?: string | null; adsetName?: string | null },
    userAccessToken: string,
    opts?: { since?: string; until?: string; bypassCache?: boolean },
  ): Promise<AccountEstimateResult | null> {
    if (adsetRef.adsetId) {
      return this.fetchLevelMessagingInsights(
        account,
        'adset',
        { field: 'adset.id', value: adsetRef.adsetId },
        userAccessToken,
        opts,
      );
    }
    if (adsetRef.adsetName?.trim()) {
      return this.fetchLevelMessagingInsights(
        account,
        'adset',
        { field: 'adset.name', value: adsetRef.adsetName.trim() },
        userAccessToken,
        opts,
      );
    }
    return null;
  }

  /**
   * Chi phí messaging theo **chiến dịch** — fallback khi không có adset id.
   */
  async fetchCampaignMessagingInsights(
    account: AdAccountRow,
    campaignRef: { campaignId?: string | null; campaignName?: string | null },
    userAccessToken: string,
    bypassCache = false,
    opts?: { since?: string; until?: string },
  ): Promise<AccountEstimateResult | null> {
    const fetchOpts = { ...opts, bypassCache };
    if (campaignRef.campaignId) {
      return this.fetchLevelMessagingInsights(
        account,
        'campaign',
        { field: 'campaign.id', value: campaignRef.campaignId },
        userAccessToken,
        fetchOpts,
      );
    }
    if (campaignRef.campaignName?.trim()) {
      return this.fetchLevelMessagingInsights(
        account,
        'campaign',
        { field: 'campaign.name', value: campaignRef.campaignName.trim() },
        userAccessToken,
        fetchOpts,
      );
    }
    return null;
  }

  /** QC đang chạy cho Page (tên ad + campaign) — quét ads của ad account. */
  async fetchLeadingAdForPage(
    adAccountId: string,
    pageId: string,
    userAccessToken: string,
  ): Promise<{ adId: string; adName: string | null; campaignName: string | null; adsetName: string | null } | null> {
    if (!pageId) return null;
    const cacheKey = `page-lead-ad:${adAccountId}:${pageId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      const d = cached.data as {
        adId?: string;
        adName?: string | null;
        campaignName?: string | null;
        adsetName?: string | null;
      };
      if (d.adId) {
        return {
          adId: d.adId,
          adName: d.adName ?? null,
          campaignName: d.campaignName ?? null,
          adsetName: d.adsetName ?? null,
        };
      }
      return null;
    }

    try {
      const pageAds = await this.listAdsForPage(adAccountId, pageId, userAccessToken, 1);
      const hit = pageAds[0];
      if (!hit) return null;
      const result = {
        adId: hit.id,
        adName: hit.name,
        campaignName: hit.campaignName,
        adsetName: hit.adsetName,
      };
      this.cache.set(cacheKey, {
        at: Date.now(),
        data: result as unknown as Omit<
          AdInsightsPayload,
          'estimatedForThisConversation' | 'localConversationCount' | 'unavailableReason'
        >,
      });
      return result;
    } catch (e) {
      this.logger.warn(
        `fetchLeadingAdForPage account=${adAccountId} page=${pageId}: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /** @deprecated Không dùng cho sidebar hội thoại — dễ lấy nhầm camp/chi tiêu toàn tài khoản. */
  private async enrichEstimateWithCampaignNames_DEPRECATED(
    account: AdAccountRow,
    userAccessToken: string,
    pageId: string | undefined,
    result: AccountEstimateResult,
  ): Promise<AccountEstimateResult> {
    const topCacheKey = `top-campaigns:${account.id}:3`;
    const cachedTop = this.cache.get(topCacheKey);
    let topCampaigns =
      cachedTop && Date.now() - cachedTop.at < this.cacheTtlMs
        ? ((cachedTop.data as { topCampaigns?: AccountEstimateResult['topCampaigns'] }).topCampaigns ??
          [])
        : [];

    if (!topCampaigns.length) {
      try {
        topCampaigns = await Promise.race([
          this.fetchTopCampaignInsights(account.id, userAccessToken, 3),
          new Promise<AccountEstimateResult['topCampaigns']>((resolve) =>
            setTimeout(() => resolve([]), 8_000),
          ),
        ]);
      } catch {
        topCampaigns = [];
      }
      if (!topCampaigns.length) {
        void this.fetchTopCampaignInsights(account.id, userAccessToken, 3).catch(() => undefined);
      }
    }

    if (pageId) {
      void this.fetchLeadingAdForPage(account.id, pageId, userAccessToken).catch(() => undefined);
    }

    const top = topCampaigns[0];
    return {
      ...result,
      topCampaigns,
      campaignName: top?.campaignName ?? null,
      adName: null,
      adsetName: null,
    };
  }

  /** Chi phí TB tin nhắn từ QC khi không có ad_id cụ thể. */
  async fetchAccountMessagingEstimate(
    userAccessToken: string,
    preferredAccountIds?: string[],
    pageId?: string,
  ): Promise<AccountEstimateResult | null> {
    const cacheKey = `account-estimate:${userAccessToken.slice(0, 12)}:${pageId ?? 'all'}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      const meta = cached.data as unknown as AccountEstimateResult;
      return {
        currency: meta.currency,
        spend: meta.spend,
        messagingConversations: meta.messagingConversations,
        costPerConversation: meta.costPerConversation,
        dateStart: meta.dateStart,
        dateStop: meta.dateStop,
        adAccountId: meta.adAccountId ?? null,
        adAccountName: meta.adAccountName ?? null,
        campaignName: meta.campaignName ?? null,
        campaignId: meta.campaignId ?? null,
        adName: meta.adName ?? null,
        adsetName: meta.adsetName ?? null,
        adsetId: meta.adsetId ?? null,
        topCampaigns: meta.topCampaigns ?? [],
      };
    }

    const accounts = await this.fetchAdAccounts(userAccessToken);
    const preferred = (preferredAccountIds ?? []).filter(Boolean);
    const activeAccounts = accounts.filter((a) => a.id && a.account_status !== 2);
    if (!activeAccounts.length && accounts[0]?.id) activeAccounts.push(accounts[0]);
    if (!activeAccounts.length) return null;

    if (pageId) {
      const ordered = this.orderAccountsForPage(pageId, activeAccounts, 2);
      const fast = await this.fetchPageAdInsightsFast(pageId, ordered, userAccessToken);
      if (fast) {
        this.cache.set(cacheKey, {
          at: Date.now(),
          data: fast as unknown as Omit<
            AdInsightsPayload,
            'estimatedForThisConversation' | 'localConversationCount' | 'unavailableReason'
          >,
        });
        return fast;
      }
    }

    const ordered: AdAccountRow[] = preferred.length
      ? activeAccounts.filter((a) => a.id && preferred.includes(a.id)).slice(0, 2)
      : activeAccounts.filter((a) => a.id).slice(0, 2);

    const datePresets = ['last_30d'] as const;
    type Best = {
      account: AdAccountRow;
      row: Record<string, unknown>;
      spend: number;
      costPerConversation: number | null;
      messagingConversations: number | null;
    };
    const candidates: Best[] = [];

    const tasks: Array<{ account: AdAccountRow; preset: string }> = [];
    for (const account of ordered) {
      for (const preset of datePresets) {
        tasks.push({ account, preset });
      }
    }
    for (const { account, preset } of tasks) {
      if (account.id && this.isAccountRateLimited(account.id)) continue;
      try {
        const row = await this.fetchAccountInsightsRow(account, userAccessToken, preset);
        if (!row) continue;
        const parsed = this.parseInsightsRow(row);
        candidates.push({
          account,
          row,
          spend: parsed.spend,
          costPerConversation: parsed.costPerConversation,
          messagingConversations: parsed.messagingConversations,
        });
      } catch (e) {
        this.logger.warn(
          `fetchAccountMessagingEstimate account=${account.id} preset=${preset}: ${this.graphErrorMessage(e)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!candidates.length) return null;

    const withMessaging = candidates.filter((c) => c.costPerConversation != null && c.spend > 0);
    const withSpend = candidates.filter((c) => c.spend > 0);
    const pick =
      withMessaging.sort(
        (a, b) =>
          b.spend + (b.costPerConversation ?? 0) * 100 - (a.spend + (a.costPerConversation ?? 0) * 100),
      )[0] ??
      withSpend.sort((a, b) => b.spend - a.spend)[0] ??
      candidates[0];
    if (!pick) return null;

    const row = pick.row;
    let result: AccountEstimateResult = {
      currency: (row.account_currency as string | undefined) ?? pick.account.currency ?? null,
      spend: pick.spend > 0 ? pick.spend : null,
      messagingConversations: pick.messagingConversations,
      costPerConversation: pick.costPerConversation,
      dateStart: (row.date_start as string | undefined) ?? null,
      dateStop: (row.date_stop as string | undefined) ?? null,
      adAccountId: pick.account.id,
      adAccountName: pick.account.name ?? null,
      campaignName: null,
      campaignId: null,
      adName: null,
      adsetName: null,
      adsetId: null,
      topCampaigns: [],
    };

    result = await this.enrichEstimateWithCampaignNames_DEPRECATED(
      pick.account,
      userAccessToken,
      pageId,
      result,
    );

    this.cache.set(cacheKey, {
      at: Date.now(),
      data: {
        adId: '',
        adName: result.adName,
        adsetName: result.adsetName,
        campaignName: result.campaignName,
        currency: result.currency,
        spend: result.spend,
        impressions: null,
        clicks: null,
        messagingConversations: result.messagingConversations,
        costPerConversation: result.costPerConversation,
        dateStart: result.dateStart,
        dateStop: result.dateStop,
        adAccountId: result.adAccountId,
        adAccountName: result.adAccountName,
        topCampaigns: result.topCampaigns,
      } as unknown as Omit<
        AdInsightsPayload,
        'estimatedForThisConversation' | 'localConversationCount' | 'unavailableReason'
      >,
    });
    return result;
  }
}
