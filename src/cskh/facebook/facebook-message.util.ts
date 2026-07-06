import type { FbMessage } from './facebook-graph.service';
import { isAdReferralNoiseText } from './facebook-referral.util';

export type ChatMessageType = 'text' | 'image' | 'video' | 'sticker';

export type NormalizedChatMessage = {
  text: string;
  attachmentUrl?: string | null;
  /** Nhiều ảnh/video trong cùng một tin Facebook. */
  attachmentUrls?: string[];
  messageType: ChatMessageType;
  sender: 'Staff' | 'Customer';
  timestamp: string;
};

/** PSID khách trong webhook/Graph — ưu tiên participant đã biết. */
export function resolveMessengerCustomerPsid(
  senderPsid: string,
  recipientPsid: string,
  pageId: string,
  options?: { isEcho?: boolean; participantPsid?: string | null },
): string | null {
  const sender = String(senderPsid || '');
  const recipient = String(recipientPsid || '');
  const page = String(pageId || '');

  if (options?.participantPsid) {
    return String(options.participantPsid);
  }
  if (!sender || !recipient) return null;

  if (options?.isEcho || sender === page) {
    return recipient !== page ? recipient : null;
  }
  if (recipient === page) {
    return sender;
  }
  // Page/agent → khách: recipient là PSID khách
  if (recipient !== page) {
    return recipient;
  }
  return sender;
}

/** Tin từ khách khi from.id trùng PSID khách của hội thoại. */
export function isMessengerFromCustomer(senderPsid: string, customerPsid: string): boolean {
  return String(senderPsid) === String(customerPsid);
}

const FB_MEDIA_URL =
  /https?:\/\/(?:[\w.-]+\.)*(?:fbcdn\.net|fbsbx\.com)\/[^\s<>"']+/i;

/** Tin hệ thống Facebook — không phải hội thoại NV ↔ khách thực tế. */
export function isNoiseMessageText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;

  const patterns: RegExp[] = [
    /^Chào\s+.+\!\s*Chúng tôi có thể giúp gì cho bạn\??$/i,
    /^Hi\s+.+\!\s*How can we help you\??$/i,
    /^Xin chào\s+.+\!\s*Chúng tôi có thể giúp gì/i,
    /Bạn đang phản hồi bình luận/i,
    /You(?:'re| are) responding to a (?:user'?s? )?comment/i,
    /Xem bình luận\.?\s*\(?https?:\/\/(www\.)?facebook\.com/i,
    /View comment\.?\s*\(?https?:\/\/(www\.)?facebook\.com/i,
    /https?:\/\/(www\.)?facebook\.com\/reel\/[^\s)]*comment_id=/i,
    /https?:\/\/(www\.)?facebook\.com\/[^\s)]*comment_id=/i,
    /sent (?:you )?a product/i,
  ];

  if (isAdReferralNoiseText(t)) return true;
  return patterns.some((p) => p.test(t));
}

export function isFbMediaUrl(url: string): boolean {
  return /^https:\/\/([a-z0-9-]+\.)*(fbcdn\.net|fbsbx\.com)\//i.test(url.trim());
}

export function isVideoMediaUrl(url: string): boolean {
  const u = url.trim();
  return (
    /\.(mp4|mpeg|webm|mov)(\?|$)/i.test(u) ||
    /\/video\//i.test(u) ||
    /\/v\/t\d+\/\d+\/\d+\/\d+\/[^/?]+\.mp4/i.test(u)
  );
}

export function isImageMediaUrl(url: string): boolean {
  const u = url.trim();
  return (
    /\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i.test(u) ||
    /\/v\/t39\.|\/v\/t1\.|image\//i.test(u) ||
    (isFbMediaUrl(u) && !isVideoMediaUrl(u))
  );
}

export function looksLikeFbMediaFragment(text: string): boolean {
  const t = text.trim();
  if (!t || t.startsWith('http')) return false;
  return /[&?](oh=03_|oe=|dl=1)/.test(t) && t.length > 30;
}

export function looksLikeEmbeddedMediaText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^\[(Video|Ảnh|Sticker|attachment)\]/i.test(t)) return true;
  if (FB_MEDIA_URL.test(t)) return true;
  return looksLikeFbMediaFragment(t);
}

/** Trích URL ảnh/video từ text đã lưu (legacy hoặc Graph trả text kèm URL). */
export function parseMediaFromText(text: string): {
  displayText: string;
  attachmentUrl: string | null;
  messageType: ChatMessageType;
} {
  let t = (text || '').trim();

  const videoPrefix = t.match(/^\[Video\]\s*(https?:\/\/\S+)?/i);
  if (videoPrefix) {
    const url = videoPrefix[1] ?? t.match(FB_MEDIA_URL)?.[0] ?? null;
    return {
      displayText: url ? '' : '[Video]',
      attachmentUrl: url,
      messageType: 'video',
    };
  }

  const imagePrefix = t.match(/^\[Ảnh\]\s*(https?:\/\/\S+)?/i);
  if (imagePrefix) {
    const url = imagePrefix[1] ?? t.match(FB_MEDIA_URL)?.[0] ?? null;
    return {
      displayText: url ? '' : '[Ảnh]',
      attachmentUrl: url,
      messageType: 'image',
    };
  }

  const url = t.match(FB_MEDIA_URL)?.[0] ?? null;
  if (url) {
    const rest = t.replace(url, '').trim();
    if (isVideoMediaUrl(url)) {
      return { displayText: rest, attachmentUrl: url, messageType: 'video' };
    }
    if (isImageMediaUrl(url)) {
      return { displayText: rest, attachmentUrl: url, messageType: 'image' };
    }
  }

  if (looksLikeFbMediaFragment(t)) {
    return { displayText: '', attachmentUrl: null, messageType: 'image' };
  }

  if (/^\[Sticker\]$/i.test(t)) {
    return { displayText: '[Sticker]', attachmentUrl: null, messageType: 'sticker' };
  }

  return { displayText: t, attachmentUrl: null, messageType: 'text' };
}

/** Sửa tin đã lưu sai (URL trong text thay vì attachmentUrl). */
export function repairStoredMessage(
  text: string,
  attachmentUrl?: string | null,
  messageType?: string | null,
): {
  changed: boolean;
  text: string;
  attachmentUrl: string | null;
  messageType: ChatMessageType;
} {
  const parsed = parseMediaFromText(text);
  let nextText = parsed.displayText;
  let nextUrl = attachmentUrl ?? parsed.attachmentUrl;
  let nextType: ChatMessageType =
    messageType === 'video' || messageType === 'image' || messageType === 'sticker'
      ? messageType
      : parsed.messageType;

  if (nextUrl && nextType === 'text') {
    nextType = isVideoMediaUrl(nextUrl) ? 'video' : 'image';
  }

  if (!nextUrl && parsed.attachmentUrl) {
    nextUrl = parsed.attachmentUrl;
    nextType = parsed.messageType;
  }

  if (nextType === 'image' && nextText === nextUrl) nextText = '[Ảnh]';
  if (nextType === 'video' && nextText.startsWith('[Video]')) nextText = '';
  if (nextType === 'image' && !nextText && !nextUrl) nextText = '[Ảnh]';
  if (nextType === 'video' && !nextText && !nextUrl) nextText = '[Video]';

  const changed =
    nextText !== text ||
    (nextUrl ?? null) !== (attachmentUrl ?? null) ||
    nextType !== (messageType || 'text');

  return { changed, text: nextText, attachmentUrl: nextUrl ?? null, messageType: nextType };
}

type FbAttachment = {
  mime_type?: string;
  type?: string;
  id?: string;
  url?: string;
  image_url?: string;
  image_data?: {
    url?: string;
    preview_url?: string;
    media_url?: string;
    width?: number;
    height?: number;
  };
  video_data?: { url?: string; preview_url?: string };
  file_url?: string;
  payload?: {
    url?: string;
    template_type?: string;
    elements?: Array<{ image_url?: string; title?: string; subtitle?: string }>;
  };
};

export function pickAttachmentUrl(att: FbAttachment | null | undefined): string | null {
  if (!att) return null;

  const videoUrl = att.video_data?.url ?? att.video_data?.preview_url ?? null;
  if (videoUrl) return videoUrl;

  const imageUrl =
    att.image_data?.url ??
    att.image_data?.preview_url ??
    att.image_data?.media_url ??
    att.image_url ??
    att.file_url ??
    att.url ??
    att.payload?.url ??
    null;
  if (imageUrl) return imageUrl;

  const templateImage = att.payload?.elements?.find((el) => el.image_url?.startsWith('http'))
    ?.image_url;
  return templateImage ?? null;
}

/** Loại URL trùng (preview/full CDN giống nhau). */
export function dedupeMediaUrls(urls: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const u = (raw ?? '').trim();
    if (!u.startsWith('http')) continue;
    const key = u.split('?')[0].replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

export function attachmentMediaKind(
  att: FbAttachment | null | undefined,
): 'video' | 'image' | null {
  if (!att) return null;
  if (att.type === 'video' || att.mime_type?.startsWith('video/')) return 'video';
  if (
    att.type === 'image' ||
    att.mime_type?.startsWith('image/') ||
    att.image_data?.url ||
    att.image_data?.preview_url
  ) {
    return 'image';
  }
  const url = pickAttachmentUrl(att);
  if (!url) return null;
  return isVideoMediaUrl(url) ? 'video' : 'image';
}

export function messageNeedsMediaResolve(msg: FbMessage): boolean {
  const attachments = (msg.attachments?.data ?? []) as FbAttachment[];
  if (msg.sticker) return false;
  if (!attachments.length) return false;
  if (attachments.some((att) => pickAttachmentUrl(att))) return false;
  return attachments.some(
    (att) =>
      att?.type === 'image' ||
      att?.type === 'video' ||
      att?.mime_type?.startsWith('image/') ||
      att?.mime_type?.startsWith('video/') ||
      Boolean(att?.id),
  );
}

export function extractAllMessageAttachments(msg: FbMessage): Array<{
  attachmentUrl: string | null;
  messageType: ChatMessageType;
  label: string;
}> {
  if (msg.sticker) {
    return [{ attachmentUrl: null, messageType: 'sticker', label: '[Sticker]' }];
  }

  const attachments = (msg.attachments?.data ?? []) as FbAttachment[];
  if (!attachments.length) {
    return [];
  }

  const results: Array<{
    attachmentUrl: string | null;
    messageType: ChatMessageType;
    label: string;
  }> = [];

  for (const att of attachments) {
    const mediaUrl = pickAttachmentUrl(att);
    const kind =
      attachmentMediaKind(att) ??
      (mediaUrl ? (isVideoMediaUrl(mediaUrl) ? 'video' : 'image') : null);

    if (kind === 'video') {
      results.push({ attachmentUrl: mediaUrl, messageType: 'video', label: '[Video]' });
    } else if (kind === 'image' || mediaUrl) {
      results.push({ attachmentUrl: mediaUrl, messageType: 'image', label: '[Ảnh]' });
    } else {
      results.push({
        attachmentUrl: mediaUrl,
        messageType: 'text',
        label: `[${att.mime_type || att.type || 'file'}]`,
      });
    }
  }

  return results;
}

export function extractMessageAttachment(msg: FbMessage): {
  attachmentUrl?: string | null;
  messageType: ChatMessageType;
  label: string;
} {
  const all = extractAllMessageAttachments(msg);
  if (!all.length) {
    return { messageType: 'text', label: '' };
  }
  return all[0];
}

export function normalizeFbMessage(
  msg: FbMessage,
  pageId: string,
  customerPsid?: string,
): NormalizedChatMessage | null {
  const fromId = String(msg.from?.id || '');
  if (!fromId) return null;
  // Phân loại theo PSID khách: chỉ tin từ đúng PSID khách là Customer,
  // mọi người gửi khác (page, nhân viên, bot) đều là Staff.
  const sender: 'Staff' | 'Customer' = customerPsid
    ? fromId === String(customerPsid)
      ? 'Customer'
      : 'Staff'
    : fromId === String(pageId)
      ? 'Staff'
      : 'Customer';
  const allAttachments = extractAllMessageAttachments(msg);
  const mediaAttachments = allAttachments.filter(
    (a) => a.messageType === 'image' || a.messageType === 'video',
  );
  const mediaUrls = dedupeMediaUrls(
    mediaAttachments.map((a) => a.attachmentUrl).filter((u): u is string => Boolean(u)),
  );

  let text = (msg.message || '').trim();
  let attachmentUrl = mediaUrls[0] ?? null;
  let attachmentUrls: string[] | undefined =
    mediaUrls.length > 1 ? mediaUrls : undefined;
  let messageType: ChatMessageType = mediaAttachments[0]?.messageType ?? 'text';

  if (text && looksLikeEmbeddedMediaText(text) && mediaUrls.length === 0) {
    const parsed = parseMediaFromText(text);
    if (parsed.attachmentUrl) {
      attachmentUrl = parsed.attachmentUrl;
      attachmentUrls = [parsed.attachmentUrl];
      messageType = parsed.messageType;
      text = parsed.displayText;
    } else if (parsed.messageType === 'image' && looksLikeFbMediaFragment(text)) {
      text = '[Ảnh]';
      messageType = 'image';
    }
  }

  if (mediaUrls.length > 0) {
    const primaryLabel = mediaAttachments[0]?.label ?? '[Ảnh]';
    if (!text || looksLikeEmbeddedMediaText(text)) {
      text = mediaUrls.length > 1 ? '' : primaryLabel;
    }
    if (messageType === 'video') text = '';
    if (messageType === 'image' && mediaUrls.length === 1 && looksLikeEmbeddedMediaText(text)) {
      text = '[Ảnh]';
    }
  } else if (allAttachments.length === 1 && allAttachments[0].messageType === 'sticker') {
    text = text || allAttachments[0].label;
    messageType = 'sticker';
  } else if (!text && allAttachments[0]?.label) {
    text = allAttachments[0].label;
    messageType = allAttachments[0].messageType;
  }

  if (!text && mediaUrls.length === 0) return null;
  if (text && isNoiseMessageText(text)) return null;

  return {
    text,
    attachmentUrl,
    attachmentUrls,
    messageType,
    sender,
    timestamp: msg.created_time || '',
  };
}

/**
 * Đếm tin KHÁCH chưa được trả lời: các tin liên tiếp mới nhất từ khách
 * cho tới khi gặp tin page/nhân viên. rawMsgs theo thứ tự Graph: mới → cũ.
 */
export function computeTrailingCustomerUnread(
  rawMsgs: FbMessage[],
  pageId: string,
  customerPsid: string,
): number {
  let count = 0;
  for (const m of rawMsgs) {
    const normalized = normalizeFbMessage(m, pageId, customerPsid);
    if (!normalized) continue;
    if (normalized.sender === 'Staff') break;
    count++;
  }
  return count;
}

export function dedupeChatMessages(messages: NormalizedChatMessage[]): NormalizedChatMessage[] {
  const seen = new Set<string>();
  const result: NormalizedChatMessage[] = [];

  for (const msg of messages) {
    const dedupeKey = `${msg.timestamp}|${msg.sender}|${msg.text}|${msg.attachmentUrl ?? ''}|${(msg.attachmentUrls ?? []).join(',')}|${msg.messageType}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const prev = result[result.length - 1];
    if (
      prev &&
      prev.text === msg.text &&
      prev.sender === msg.sender &&
      prev.attachmentUrl === msg.attachmentUrl &&
      prev.messageType === msg.messageType &&
      msg.timestamp &&
      prev.timestamp
    ) {
      const gap = Math.abs(
        new Date(msg.timestamp).getTime() - new Date(prev.timestamp).getTime(),
      );
      if (gap < 3 * 60 * 1000) continue;
    }

    result.push(msg);
  }

  return result;
}

export const FB_ATTACHMENT_FIELDS =
  'type,mime_type,id,url,image_url,image_data{url,preview_url,media_url,width,height},video_data{url,preview_url},file_url,payload{url,template_type,elements{image_url,title,subtitle}}';

export const FB_MESSAGE_ATTACHMENT_FIELDS = `attachments{${FB_ATTACHMENT_FIELDS}}`;

export const FB_MESSAGE_FIELDS = `id,message,from,created_time,sticker,${FB_MESSAGE_ATTACHMENT_FIELDS}`;

const FB_MEDIA_PROXY_HOST =
  /(?:^|\.)((?:fbcdn\.net|fbsbx\.com|facebook\.com|fb\.com))$/i;

/** Host Facebook CDN hợp lệ cho proxy media. */
export function isAllowedFacebookMediaUrl(raw: string): boolean {
  const url = (raw || '').trim();
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return FB_MEDIA_PROXY_HOST.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Lấy URL gốc từ query proxy.
 * Express cắt URL tại `&` nếu client không encode — đọc lại từ originalUrl.
 */
export function parseMediaProxyUrlFromRequest(rawUrl: string, queryUrl: unknown): string {
  const fromQuery = typeof queryUrl === 'string' ? queryUrl.trim() : '';
  if (fromQuery && isAllowedFacebookMediaUrl(fromQuery)) {
    return fromQuery;
  }

  const match = (rawUrl || '').match(/[?&]url=([^#]+)/);
  if (match?.[1]) {
    let candidate = match[1];
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      /* giữ nguyên */
    }
    if (isAllowedFacebookMediaUrl(candidate)) return candidate;
  }

  return fromQuery;
}
