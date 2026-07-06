import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { GRAPH_BASE } from './facebook-oauth.util';
import {
  extractPageIdFromCreative,
  extractPageIdFromPromotedObject,
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
  /** ad = có mã QC; campaign = theo chiến dịch; page = TB theo Page */
  insightsScope?: 'ad' | 'campaign' | 'page' | null;
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
] as const;

type AdAccountRow = { id: string; name?: string; account_id?: string; currency?: string; account_status?: number };

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
  adName: string | null;
  adsetName: string | null;
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
  private assignedPagesApiBrokenUntil = 0;

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
    if (
      costPerConversation == null &&
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

  async fetchAdInsights(
    adId: string,
    userAccessToken: string,
    opts?: { since?: Date; until?: Date },
  ): Promise<Omit<AdInsightsPayload, 'estimatedForThisConversation' | 'localConversationCount' | 'unavailableReason'>> {
    const since = opts?.since ? this.formatDate(opts.since) : null;
    const until = opts?.until ? this.formatDate(opts.until) : null;
    const cacheKey = `${adId}:v2:${since ?? 'default'}:${until ?? 'default'}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.data;
    }

    const params: Record<string, string> = {
      fields:
        'spend,impressions,clicks,actions,cost_per_action_type,campaign_name,adset_name,ad_name,account_currency,date_start,date_stop',
      access_token: userAccessToken,
    };
    if (since && until) {
      params.time_range = JSON.stringify({ since, until });
    } else {
      params.date_preset = 'last_30d';
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
      const msg = axios.isAxiosError(e)
        ? (e.response?.data as { error?: { message?: string } })?.error?.message || e.message
        : (e as Error).message;
      this.logger.warn(`fetchAdInsights ad=${adId}: ${msg}`);
      throw new Error(msg);
    }
  }

  /** Tài khoản QC được gán quyền chạy ads cho Page này (assigned_pages). */
  async filterAdAccountsForPage(
    pageId: string,
    userAccessToken: string,
    accounts: AdAccountRow[],
  ): Promise<AdAccountRow[]> {
    if (!pageId || !accounts.length) return [];

    const cacheKey = `${pageId}:${accounts.slice(0, 3).map((a) => a.id).join(',')}`;
    const cached = this.pageAccountFilterCache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.pageAccountFilterCacheTtlMs) {
      return cached.accounts;
    }

    if (Date.now() < this.assignedPagesApiBrokenUntil) {
      const fallback = accounts.slice(0, 2);
      this.pageAccountFilterCache.set(cacheKey, { at: Date.now(), accounts: fallback });
      return fallback;
    }

    const slice = accounts.slice(0, 3);
    let fail400 = 0;
    const checks = await Promise.all(
      slice.map(async (account) => {
        if (!account.id) return null;
        try {
          const res = await axios.get(`${GRAPH_BASE}/${account.id}/assigned_pages`, {
            params: { fields: 'id', limit: 50, access_token: userAccessToken },
            timeout: 8_000,
          });
          const pages = Array.isArray(res.data?.data) ? res.data.data : [];
          if (pages.some((p: { id?: string }) => p.id === pageId)) return account;
        } catch (e) {
          const status = axios.isAxiosError(e) ? e.response?.status : undefined;
          if (status === 400) fail400++;
          this.logger.debug(
            `filterAdAccountsForPage ${account.id} page=${pageId}: ${(e as Error).message}`,
          );
        }
        return null;
      }),
    );
    const matched = checks.filter((a): a is AdAccountRow => a != null);
    if (!matched.length && fail400 >= slice.length) {
      this.assignedPagesApiBrokenUntil = Date.now() + 3_600_000;
      const fallback = accounts.slice(0, 2);
      this.pageAccountFilterCache.set(cacheKey, { at: Date.now(), accounts: fallback });
      return fallback;
    }
    this.pageAccountFilterCache.set(cacheKey, { at: Date.now(), accounts: matched });
    return matched;
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
    preset: string,
  ): Promise<Record<string, unknown> | null> {
    const res = await axios.get(`${GRAPH_BASE}/${account.id}/insights`, {
      params: {
        fields: 'spend,actions,cost_per_action_type,account_currency,date_start,date_stop',
        date_preset: preset,
        access_token: userAccessToken,
      },
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

  /** QC của Page — ưu tiên adset.promoted_object.page_id (Click-to-Messenger), fallback creative. */
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

    // 1) Ad sets targeting this Page (Messaging ads — promoted_object.page_id)
    try {
      const adsetRes = await axios.get(`${GRAPH_BASE}/${adAccountId}/adsets`, {
        params: {
          fields:
            'id,name,promoted_object,ads{id,name,effective_status,campaign{id,name},adset{id,name}}',
          limit: 100,
          filtering: JSON.stringify([
            { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] },
          ]),
          access_token: userAccessToken,
        },
        timeout: 25_000,
      });
      const adsets = Array.isArray(adsetRes.data?.data) ? adsetRes.data.data : [];
      const matchedAdsets: Array<Record<string, unknown>> = [];
      for (const adset of adsets as Array<Record<string, unknown>>) {
        const po = adset.promoted_object as Record<string, unknown> | undefined;
        if (po?.page_id !== pageId) continue;
        matchedAdsets.push(adset);
        const ads = adset.ads as { data?: Array<Record<string, unknown>> } | undefined;
        for (const ad of ads?.data ?? []) {
          pushAd(ad, (adset.name as string | undefined) ?? null);
        }
      }
      // Graph thường không trả nested ads — lấy từng adset
      for (const adset of matchedAdsets) {
        if (pageAds.length >= limit) break;
        const adsetId = String(adset.id ?? '');
        if (!adsetId) continue;
        try {
          const adsRes = await axios.get(`${GRAPH_BASE}/${adsetId}/ads`, {
            params: {
              fields: 'id,name,effective_status,campaign{id,name},adset{id,name}',
              limit: 50,
              access_token: userAccessToken,
            },
            timeout: 15_000,
          });
          for (const ad of (adsRes.data?.data ?? []) as Array<Record<string, unknown>>) {
            pushAd(ad, (adset.name as string | undefined) ?? null);
          }
        } catch {
          /* ignore per-adset */
        }
      }
    } catch (e) {
      this.logger.debug(
        `listAdsForPage adsets account=${adAccountId} page=${pageId}: ${(e as Error).message}`,
      );
    }

    // 2) Quét ads + creative page_id (lead / engagement)
    if (pageAds.length < limit) {
      try {
        const res = await axios.get(`${GRAPH_BASE}/${adAccountId}/ads`, {
          params: {
            fields:
              'id,name,effective_status,campaign{id,name},adset{id,name,promoted_object},creative{object_story_spec}',
            limit: 150,
            filtering: JSON.stringify([
              { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] },
            ]),
            access_token: userAccessToken,
          },
          timeout: 25_000,
        });
        const rows = Array.isArray(res.data?.data) ? res.data.data : [];
        for (const row of rows as Array<Record<string, unknown>>) {
          if (pageAds.length >= limit) break;
          const creative = row.creative as Record<string, unknown> | undefined;
          const adset = row.adset as Record<string, unknown> | undefined;
          const pageMatch =
            extractPageIdFromCreative(creative) === pageId ||
            extractPageIdFromPromotedObject(adset) === pageId;
          if (!pageMatch) continue;
          pushAd(row);
        }
      } catch (e) {
        this.logger.warn(
          `listAdsForPage ads account=${adAccountId} page=${pageId}: ${(e as Error).message}`,
        );
      }
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
    opts?: { since?: string; until?: string },
  ): Promise<AccountEstimateResult | null> {
    if (!pageId || !account.id) return null;
    const since = opts?.since?.trim();
    const until = opts?.until?.trim();
    const rangeKey = since && until ? `${since}:${until}` : 'last_30d';
    const cacheKey = `page-messaging:v3:${account.id}:${pageId}:${rangeKey}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.data as unknown as AccountEstimateResult;
    }

    const pageAds = await this.listAdsForPage(account.id, pageId, userAccessToken);
    if (!pageAds.length) return null;

    const adIds = pageAds.map((a) => a.id).slice(0, 40);
    let insightRows: Array<Record<string, unknown>> = [];
    try {
      const insightParams: Record<string, string | number> = {
        level: 'ad',
        fields:
          'ad_id,ad_name,campaign_name,adset_name,spend,actions,cost_per_action_type,account_currency,date_start,date_stop',
        filtering: JSON.stringify([{ field: 'ad.id', operator: 'IN', value: adIds }]),
        limit: 100,
        access_token: userAccessToken,
      };
      if (since && until) {
        insightParams.time_range = JSON.stringify({ since, until });
      } else {
        insightParams.date_preset = 'last_30d';
      }
      const res = await axios.get(`${GRAPH_BASE}/${account.id}/insights`, {
        params: insightParams,
        timeout: 20_000,
      });
      insightRows = Array.isArray(res.data?.data) ? res.data.data : [];
    } catch (e) {
      this.logger.warn(
        `fetchPageMessagingInsights account=${account.id} page=${pageId}: ${(e as Error).message}`,
      );
      return null;
    }

    if (!insightRows.length) return null;

    let totalSpend = 0;
    let totalMessaging = 0;
    let bestAdId: string | null = null;
    let bestMessaging = 0;

    for (const row of insightRows) {
      const parsed = this.parseInsightsRow(row);
      totalSpend += parsed.spend;
      const msg = parsed.messagingConversations ?? 0;
      totalMessaging += msg;
      const adId = String(row.ad_id ?? '');
      if (msg > bestMessaging) {
        bestMessaging = msg;
        bestAdId = adId || null;
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
      campaignName: bestAdMeta?.campaignName ?? null,
      adName: bestAdMeta?.name ?? null,
      adsetName: bestAdMeta?.adsetName ?? null,
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
   * Chi phí messaging theo **chiến dịch** (khớp Ads Manager) — không phải TB cả Page.
   */
  async fetchCampaignMessagingInsights(
    account: AdAccountRow,
    campaignName: string,
    userAccessToken: string,
  ): Promise<AccountEstimateResult | null> {
    if (!account.id || !campaignName.trim()) return null;
    const cacheKey = `campaign-messaging:v2:${account.id}:${campaignName}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.data as unknown as AccountEstimateResult;
    }

    const filters = [
      { field: 'campaign.name', operator: 'EQUAL', value: campaignName },
    ];
    let insightRows: Array<Record<string, unknown>> = [];
    try {
      const res = await axios.get(`${GRAPH_BASE}/${account.id}/insights`, {
        params: {
          level: 'campaign',
          fields:
            'campaign_name,spend,actions,cost_per_action_type,account_currency,date_start,date_stop',
          date_preset: 'last_30d',
          filtering: JSON.stringify(filters),
          limit: 5,
          access_token: userAccessToken,
        },
        timeout: 20_000,
      });
      insightRows = Array.isArray(res.data?.data) ? res.data.data : [];
    } catch (e) {
      this.logger.warn(
        `fetchCampaignMessagingInsights account=${account.id} campaign=${campaignName.slice(0, 40)}: ${(e as Error).message}`,
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
      campaignName: (row.campaign_name as string | undefined) ?? campaignName,
      adName: null,
      adsetName: null,
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
        adName: meta.adName ?? null,
        adsetName: meta.adsetName ?? null,
        topCampaigns: meta.topCampaigns ?? [],
      };
    }

    const accounts = await this.fetchAdAccounts(userAccessToken);
    const preferred = (preferredAccountIds ?? []).filter(Boolean);
    const activeAccounts = accounts.filter((a) => a.id && a.account_status !== 2);
    if (!activeAccounts.length && accounts[0]?.id) activeAccounts.push(accounts[0]);
    if (!activeAccounts.length) return null;

    let pageLinked: AdAccountRow[] = [];
    if (pageId && !preferred.length) {
      pageLinked = await this.filterAdAccountsForPage(pageId, userAccessToken, activeAccounts.slice(0, 3));
    }

    const ordered: AdAccountRow[] = preferred.length
      ? activeAccounts.filter((a) => a.id && preferred.includes(a.id)).slice(0, 2)
      : [
          ...pageLinked,
          ...activeAccounts.filter((a) => a.id && !pageLinked.some((p) => p.id === a.id)),
        ].slice(0, 2);

    const datePresets = ['last_30d'] as const;
    type Best = {
      account: AdAccountRow;
      row: Record<string, unknown>;
      spend: number;
      costPerConversation: number | null;
      messagingConversations: number | null;
    };
    const candidates: Best[] = [];

    const tasks: Array<Promise<void>> = [];
    for (const account of ordered) {
      for (const preset of datePresets) {
        tasks.push(
          (async () => {
            try {
              const row = await this.fetchAccountInsightsRow(account, userAccessToken, preset);
              if (!row) return;
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
                `fetchAccountMessagingEstimate account=${account.id} preset=${preset}: ${(e as Error).message}`,
              );
            }
          })(),
        );
      }
    }
    await Promise.all(tasks);

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
      adName: null,
      adsetName: null,
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
