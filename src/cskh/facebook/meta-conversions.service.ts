import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { createHash } from 'crypto';
import { GRAPH_BASE } from './facebook-oauth.util';

export type MetaPurchaseReportInput = {
  pageId: string;
  pageAccessToken: string;
  psid: string;
  /** messenger | instagram */
  messagingChannel: 'messenger' | 'instagram';
  orderId: string;
  orderName?: string | null;
  value: number | null;
  currency?: string;
  /** Ad đã chọn khi tạo đơn — log / custom data (attribution chính qua PSID). */
  adId?: string | null;
  phone?: string | null;
};

export type MetaPurchaseReportResult = {
  ok: boolean;
  datasetId?: string | null;
  skipped?: boolean;
  reason?: string | null;
  eventsReceived?: number | null;
};

/**
 * Conversions API for Business Messaging — Purchase.
 * @see https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging/
 *
 * Sự kiện này vào bucket “báo cáo bên thứ ba / CAPI”, không phải “Meta tự phát hiện”.
 */
@Injectable()
export class MetaConversionsService {
  private readonly logger = new Logger(MetaConversionsService.name);
  private readonly datasetCache = new Map<string, { at: number; id: string }>();
  private readonly datasetTtlMs = 6 * 3_600_000;
  private readonly partnerAgent =
    process.env.META_CAPI_PARTNER_AGENT?.trim() || 'CQA_CRM';

  isEnabled(): boolean {
    return process.env.META_CAPI_PURCHASE_ENABLED !== 'false';
  }

  async reportPurchase(input: MetaPurchaseReportInput): Promise<MetaPurchaseReportResult> {
    if (!this.isEnabled()) {
      return { ok: false, skipped: true, reason: 'meta_capi_disabled' };
    }
    const pageId = input.pageId?.trim();
    const token = input.pageAccessToken?.trim();
    const psid = input.psid?.trim();
    if (!pageId || !token || !psid) {
      return { ok: false, skipped: true, reason: 'missing_page_psid_or_token' };
    }

    try {
      const datasetId =
        process.env.META_CAPI_DATASET_ID?.trim() ||
        (await this.resolveDatasetId(pageId, token));
      if (!datasetId) {
        return { ok: false, skipped: true, reason: 'dataset_unavailable' };
      }

      const value =
        input.value != null && Number.isFinite(input.value) && input.value > 0
          ? Number(input.value)
          : 0;
      const currency = (input.currency || 'VND').toUpperCase();
      const eventTime = Math.floor(Date.now() / 1000);
      const eventId = `oms_${input.orderId}`.slice(0, 64);

      const userData: Record<string, string> = {
        page_id: pageId,
        page_scoped_user_id: psid,
      };
      const phoneHash = this.hashPhone(input.phone);
      if (phoneHash) userData.ph = phoneHash;

      const customData: Record<string, unknown> = {
        currency,
        value,
        order_id: input.orderName || input.orderId,
      };
      if (input.adId?.trim()) {
        customData.ad_id = input.adId.trim();
      }

      const body = {
        data: [
          {
            event_name: 'Purchase',
            event_time: eventTime,
            event_id: eventId,
            action_source: 'business_messaging',
            messaging_channel: input.messagingChannel,
            user_data: userData,
            custom_data: customData,
          },
        ],
        partner_agent: this.partnerAgent,
      };

      const res = await axios.post(`${GRAPH_BASE}/${datasetId}/events`, body, {
        params: { access_token: token },
        timeout: 20_000,
      });
      const eventsReceived =
        typeof res.data?.events_received === 'number' ? res.data.events_received : null;
      this.logger.log(
        `Meta CAPI Purchase ok page=${pageId} order=${input.orderId} dataset=${datasetId} events=${eventsReceived ?? '?'} ad=${input.adId ?? ''}`,
      );
      return { ok: true, datasetId, eventsReceived };
    } catch (e) {
      const msg = this.graphErrorMessage(e);
      this.logger.warn(
        `Meta CAPI Purchase failed page=${input.pageId} order=${input.orderId}: ${msg}`,
      );
      return { ok: false, reason: msg };
    }
  }

  /** POST /{page-id}/dataset — tạo hoặc lấy dataset gắn Page. */
  private async resolveDatasetId(pageId: string, token: string): Promise<string | null> {
    const cached = this.datasetCache.get(pageId);
    if (cached && Date.now() - cached.at < this.datasetTtlMs) return cached.id;

    try {
      const res = await axios.post(
        `${GRAPH_BASE}/${pageId}/dataset`,
        null,
        { params: { access_token: token }, timeout: 15_000 },
      );
      const id = String(res.data?.id || res.data?.dataset_id || '').trim();
      if (!id) return null;
      this.datasetCache.set(pageId, { at: Date.now(), id });
      return id;
    } catch (e) {
      this.logger.warn(`resolveDatasetId page=${pageId}: ${this.graphErrorMessage(e)}`);
      return null;
    }
  }

  private hashPhone(raw?: string | null): string | null {
    if (!raw?.trim()) return null;
    let d = raw.replace(/\D/g, '');
    if (!d) return null;
    if (d.startsWith('0')) d = `84${d.slice(1)}`;
    if (!d.startsWith('84')) d = `84${d}`;
    return createHash('sha256').update(d).digest('hex');
  }

  private graphErrorMessage(e: unknown): string {
    const ax = e as {
      response?: { data?: { error?: { message?: string; code?: number } } };
      message?: string;
    };
    return (
      ax.response?.data?.error?.message ||
      ax.message ||
      'meta_capi_error'
    );
  }
}
