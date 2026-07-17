import {
  computeMessageActivityYmdRange,
  type TranscriptLine,
} from '../audit/audit-analytics.util';
import type { ProductSearchEntry } from './insight-product-match.util';
import { matchProductsInInboundText } from './insight-product-match.util';

const VI_STOPWORDS = new Set([
  'và',
  'của',
  'cho',
  'với',
  'là',
  'có',
  'không',
  'em',
  'anh',
  'chị',
  'ạ',
  'dạ',
  'shop',
  'mình',
  'bạn',
  'này',
  'kia',
  'được',
  'nhé',
  'như',
  'thì',
  'để',
  'còn',
  'gì',
  'nha',
  'ok',
  'ơi',
  'the',
  'xin',
  'chào',
  'nay',
  'hôm',
  'ngày',
  'mai',
  'đau',
  'bị',
  'bác',
  'gia',
  'giá',
  'minh',
  'ban',
  'bán',
  'mua',
  'đặt',
  'hàng',
  'ship',
  'giao',
  'vcb',
  'vien',
  'viên',
  'thuốc',
  'sp',
  'san',
  'sản',
  'phẩm',
  'cho',
  'xin',
  'ad',
  'ib',
  'inbox',
  'zalo',
  'facebook',
  'fb',
  'combo',
  'tư',
  'vấn',
  'tu',
  'van',
  'được',
  'khong',
  'co',
  'roi',
  'rồi',
  'ạ',
  'dạ',
  'vậy',
  'vay',
  'nhiều',
  'nhieu',
  'lắm',
  'lam',
  'cần',
  'can',
  'muốn',
  'muon',
  'hỏi',
  'hoi',
  'ạ',
]);

export type InboxInsightConvRow = {
  conversationId: string;
  pageId: string;
  pageName: string | null;
  participantPsid: string;
  customerName: string | null;
  fromAd: boolean;
  adId: string | null;
  adTitle: string | null;
  referralSource: string | null;
  inboundText: string;
  messageCount: number;
  labelNames: string[];
};

export function inboxConvDedupeKey(pageId: string, participantPsid: string): string {
  return `${pageId}:${participantPsid}`;
}

export function auditDedupeKeyFromMeta(meta: Record<string, unknown> | null): string | null {
  const pageId = typeof meta?.pageId === 'string' ? meta.pageId.trim() : '';
  const psid = typeof meta?.participantPsid === 'string' ? meta.participantPsid.trim() : '';
  if (pageId && psid) return inboxConvDedupeKey(pageId, psid);
  return null;
}

export function extractKeywordsFromInboundText(text: string, limit = 8): string[] {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/https?:\/\S+/g, ' ');
  const tokens = normalized.match(/[a-z0-9à-ỹ]{4,}/gi) ?? [];
  const freq = new Map<string, number>();
  for (const raw of tokens) {
    const t = raw.trim();
    if (t.length < 4 || VI_STOPWORDS.has(t)) continue;
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

/**
 * Hàng tổng hợp từ inbox thật — chỉ volume / keyword / sản phẩm / nguồn ads.
 * Không gắn điểm QA giả: điểm & yếu tố chốt chỉ lấy từ chat_audits.
 */
export function buildInboxSyntheticAuditRow(
  conv: InboxInsightConvRow,
  from: string,
  to: string,
  productIndex?: ProductSearchEntry[],
): { score: number; metadata: Record<string, unknown> } {
  const transcript: TranscriptLine[] = conv.inboundText
    ? [{ sender: conv.customerName ?? 'Khách', text: conv.inboundText.slice(0, 1500), timestamp: '' }]
    : [];

  const activity = computeMessageActivityYmdRange(
    transcript.map((t) => ({ created_time: t.timestamp })),
  );
  const productMentions =
    productIndex && productIndex.length > 0
      ? matchProductsInInboundText(conv.inboundText, productIndex)
      : [];
  const keywords =
    productMentions.length > 0
      ? productMentions
      : extractKeywordsFromInboundText(conv.inboundText);

  return {
    // score = 0: không dùng làm điểm QA; aggregate QA lấy từ chat_audits.
    score: 0,
    metadata: {
      pageId: conv.pageId,
      pageName: conv.pageName ?? `Kênh #${conv.pageId}`,
      participantPsid: conv.participantPsid,
      conversationId: conv.conversationId,
      customerName: conv.customerName,
      fromAd: conv.fromAd,
      adId: conv.adId,
      adTitle: conv.adTitle,
      referralSource: conv.referralSource,
      activityDateFrom: activity?.from ?? from,
      activityDateTo: activity?.to ?? to,
      keywords,
      tags: conv.labelNames,
      strengths: [],
      weaknesses: [],
      sentiment: { tone: 'neutral' as const },
      customerIntent: {
        intentLabel: conv.fromAd ? 'Từ quảng cáo' : 'Tin nhắn tự nhiên',
        productMentions,
        urgency: 'normal' as const,
      },
      source: 'inbox',
      audited: false,
      inboxMessageCount: conv.messageCount,
    },
  };
}
