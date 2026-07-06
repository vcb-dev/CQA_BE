/** Meta Messenger referral (webhook message.referral / messaging_referrals). */
export type FbWebhookReferral = {
  ref?: string;
  source?: string;
  type?: string;
  ad_id?: string;
  ads_context_data?: {
    ad_title?: string;
    photo_url?: string;
    video_url?: string;
    post_id?: string;
  };
};

export type ParsedAdReferral = {
  fromAd: boolean;
  adId: string | null;
  adTitle: string | null;
  referralSource: string | null;
};

/** Mẫu regex — tin hệ thống Facebook báo khách vào từ quảng cáo. */
export const AD_REFERRAL_NOISE_PATTERNS: RegExp[] = [
  /đã trả lời một quảng cáo/i,
  /replied to (?:your|an?) ad/i,
  /replied to an advertisement/i,
  /^Bạn đã trả lời qua quảng cáo/i,
  /^You replied via ad/i,
  /Through Facebook ads/i,
  /Qua quảng cáo trên Facebook/i,
  /via (?:a )?Facebook ad/i,
  /จากโฆษณา/i,
  /ตอบกลับโฆษณ/i,
  /ตอบผ่านโฆษณ/i,
  /ตอบ.*โฆษณ.*(?:Facebook|ของคุณ)/i,
  /ผ่านโฆษณ/i,
  /โฆษณ.*Facebook/i,
  /님이 광고에/i,
  /광고를 통해/i,
];

/** Chuỗi con cho backfill SQL ILIKE (Việt / Anh / Thái). */
export const AD_REFERRAL_ILIKE_SUBSTRINGS: string[] = [
  'replied to your ad',
  'replied to an ad',
  'You replied via ad',
  'Through Facebook ads',
  'đã trả lời một quảng cáo',
  'trả lời qua quảng cáo',
  'Qua quảng cáo',
  'ตอบกลับโฆษณ',
  'ตอบผ่านโฆษณ',
  'ผ่านโฆษณ',
  'จากโฆษณ',
];

/** Tin hệ thống Facebook báo khách vào từ quảng cáo (heuristic khi không có webhook). */
export function isAdReferralNoiseText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return AD_REFERRAL_NOISE_PATTERNS.some((p) => p.test(t));
}

export function parseWebhookReferral(referral: FbWebhookReferral | null | undefined): ParsedAdReferral {
  if (!referral || typeof referral !== 'object') {
    return { fromAd: false, adId: null, adTitle: null, referralSource: null };
  }

  const source = typeof referral.source === 'string' ? referral.source.trim() : null;
  const adId = typeof referral.ad_id === 'string' && referral.ad_id.trim() ? referral.ad_id.trim() : null;
  const adTitle =
    typeof referral.ads_context_data?.ad_title === 'string' &&
    referral.ads_context_data.ad_title.trim()
      ? referral.ads_context_data.ad_title.trim()
      : null;
  const fromAd = source === 'ADS' || Boolean(adId);

  return {
    fromAd,
    adId,
    adTitle,
    referralSource: source,
  };
}

export function detectAdFromMessageTexts(texts: string[]): ParsedAdReferral {
  const hit = texts.some(isAdReferralNoiseText);
  return {
    fromAd: hit,
    adId: null,
    adTitle: null,
    referralSource: hit ? 'HEURISTIC' : null,
  };
}

export function detectAdFromFbMessages(
  messages: Array<{ message?: string | null }>,
): ParsedAdReferral {
  const texts = messages.map((m) => (m.message ?? '').trim()).filter(Boolean);
  return detectAdFromMessageTexts(texts);
}
