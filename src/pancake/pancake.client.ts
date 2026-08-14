import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { collectPhonesFromPancakeRaw, collectAddressFromPancakeRaw } from './pancake-phone.util';

const PANCAKE_BASE = (process.env.PANCAKE_BASE_URL || 'https://pages.fm').replace(/\/$/, '');

export type PancakePage = {
  id: string;
  name: string | null;
  platform: string | null;
  roleInPage: string | null;
  isActivated: boolean;
  username: string | null;
  /** activated | inactivated | hidden | nopermission | other */
  category?: string | null;
  raw?: Record<string, unknown>;
};

export type PancakeConversation = {
  id: string;
  customerName: string | null;
  customerId: string | null;
  /** Chuẩn hoá: INBOX | COMMENT (hoặc giá trị gốc nếu không nhận diện). */
  type: string | null;
  lastMessage: string | null;
  updatedAt: string | null;
  tags: string[];
  raw: Record<string, unknown>;
};

export type PancakeMessage = {
  id: string;
  message: string | null;
  fromId: string | null;
  fromName: string | null;
  createdAt: string | null;
  isFromPage: boolean;
  attachments: Array<{ url: string; type: string | null; name: string | null }>;
  raw: Record<string, unknown>;
};

export type PancakeCustomer = {
  id: string;
  name: string | null;
  phone: string | null;
  phones: string[];
  emails: string[];
  notes: string | null;
  address: string | null;
  gender: string | null;
  psid: string | null;
  customerId: string | null;
  threadId: string | null;
  lastMessage?: string | null;
  conversationType?: string | null;
  updatedAt: string | null;
  raw: Record<string, unknown>;
};

@Injectable()
export class PancakeClient {
  private readonly logger = new Logger(PancakeClient.name);

  async listPages(userAccessToken: string): Promise<{
    activated: PancakePage[];
    pages: PancakePage[];
    categorized: Record<string, unknown>;
    categoryCounts: Record<string, number>;
  }> {
    const res = await axios.get(`${PANCAKE_BASE}/api/v1/pages`, {
      params: { access_token: userAccessToken },
      timeout: 30_000,
    });
    const data = res.data as {
      success?: boolean;
      categorized?: Record<string, unknown>;
    };
    if (data?.success === false) {
      throw new Error('Pancake list pages failed');
    }
    const categorized = (data.categorized ?? {}) as Record<string, unknown>;
    const categoryCounts: Record<string, number> = {};
    // Chỉ lấy kênh đang dùng (activated) — bỏ inactivated / hidden / chết.
    const rawActivated = categorized.activated;
    const byId = new Map<string, PancakePage>();
    if (Array.isArray(rawActivated) && rawActivated.length) {
      if (typeof rawActivated[0] === 'object') {
        for (const item of rawActivated) {
          if (!item || typeof item !== 'object') continue;
          const page = this.normalizePage(item as Record<string, unknown>, 'activated');
          if (!page.id) continue;
          byId.set(page.id, page);
        }
        categoryCounts.activated = byId.size;
      } else {
        categoryCounts.activated = rawActivated.length;
      }
    } else {
      categoryCounts.activated = 0;
    }
    if (Array.isArray(categorized.inactivated)) {
      categoryCounts.inactivated = categorized.inactivated.length;
    }

    const activated = [...byId.values()].sort((a, b) =>
      (a.name || a.id).localeCompare(b.name || b.id, 'vi'),
    );
    return { activated, pages: activated, categorized, categoryCounts };
  }

  async generatePageAccessToken(
    pageId: string,
    userAccessToken: string,
  ): Promise<string> {
    const res = await axios.post(
      `${PANCAKE_BASE}/api/v1/pages/${encodeURIComponent(pageId)}/generate_page_access_token`,
      null,
      {
        params: { access_token: userAccessToken },
        timeout: 30_000,
      },
    );
    const data = res.data as Record<string, unknown>;
    const nested = (data.data as Record<string, unknown> | undefined) ?? {};
    const candidates = [
      data.page_access_token,
      data.access_token,
      data.token,
      nested.page_access_token,
      nested.access_token,
      nested.token,
    ];
    const token = candidates
      .map((v) => (typeof v === 'string' ? v.trim() : v != null ? String(v).trim() : ''))
      .find((v) => v.length > 0);
    if (!token) {
      this.logger.warn(
        `generatePageAccessToken: unexpected payload keys=${Object.keys(data)} types=${candidates
          .map((v) => (v == null ? 'null' : typeof v))
          .join(',')}`,
      );
      throw new Error(
        typeof data.message === 'string' && data.message
          ? data.message
          : 'Pancake không trả page_access_token',
      );
    }
    return token;
  }

  async listConversations(
    pageId: string,
    pageAccessToken: string,
    opts?: {
      cursor?: string;
      limit?: number;
      /** Lọc Pancake: INBOX | COMMENT */
      type?: 'INBOX' | 'COMMENT' | string;
    },
  ): Promise<{ conversations: PancakeConversation[]; nextCursor: string | null; raw: unknown }> {
    const params: Record<string, string | number> = {
      page_access_token: pageAccessToken,
    };
    // Pancake public API paginate bằng last_conversation_id (docs); một số bản còn nhận cursor.
    if (opts?.cursor) {
      params.last_conversation_id = opts.cursor;
      params.cursor = opts.cursor;
    }
    if (opts?.limit) params.limit = Math.min(opts.limit, 60);
    if (opts?.type) params.type = opts.type;

    // v2 không bắt buộc since/until; v1 trả success:false nếu thiếu → dùng v2 trước
    const urls = [
      `${PANCAKE_BASE}/api/public_api/v2/pages/${encodeURIComponent(pageId)}/conversations`,
      `${PANCAKE_BASE}/api/public_api/v1/pages/${encodeURIComponent(pageId)}/conversations`,
    ];
    let lastErr: unknown;
    for (const url of urls) {
      try {
        const res = await axios.get(url, { params, timeout: 30_000 });
        const body = res.data as { success?: boolean; message?: string; conversations?: unknown };
        if (body && typeof body === 'object' && body.success === false) {
          lastErr = new Error(body.message || 'Pancake conversations failed');
          continue;
        }
        const normalized = this.normalizeConversationsResponse(res.data, opts?.type);
        if (normalized.conversations.length > 0 || body?.success === true) {
          return normalized;
        }
        // rỗng nhưng success true → trả luôn
        if (Array.isArray(body?.conversations)) return normalized;
        lastErr = new Error('empty conversations response');
      } catch (e) {
        lastErr = e;
        const status = (e as AxiosError).response?.status;
        if (status && status !== 404) throw e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Pancake conversations failed');
  }

  async listMessages(
    pageId: string,
    conversationId: string,
    pageAccessToken: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<{ messages: PancakeMessage[]; nextCursor: string | null; raw: unknown }> {
    const params: Record<string, string | number> = {
      page_access_token: pageAccessToken,
    };
    if (opts?.cursor) params.cursor = opts.cursor;
    if (opts?.limit) params.limit = Math.min(opts.limit, 100);

    // v1 trước: v2 /messages thường trả HTML SPA (200) → empty nếu ưu tiên v2
    const urls = [
      `${PANCAKE_BASE}/api/public_api/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
      `${PANCAKE_BASE}/api/public_api/v2/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
    ];
    let lastErr: unknown;
    for (const url of urls) {
      try {
        const res = await axios.get(url, { params, timeout: 30_000 });
        if (!isPancakeJsonPayload(res.data)) {
          lastErr = new Error('Pancake messages: non-JSON response');
          continue;
        }
        const body = res.data as { success?: boolean; message?: string };
        if (body && typeof body === 'object' && body.success === false) {
          lastErr = new Error(body.message || 'Pancake messages failed');
          continue;
        }
        const normalized = this.normalizeMessagesResponse(res.data);
        if (normalized.messages.length > 0 || body?.success === true) {
          return {
            ...normalized,
            messages: tidyPancakeMessages(normalized.messages),
          };
        }
        lastErr = new Error('empty messages response');
      } catch (e) {
        lastErr = e;
        const status = (e as AxiosError).response?.status;
        if (status && status !== 404) throw e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Pancake messages failed');
  }

  async listCustomers(
    pageId: string,
    pageAccessToken: string,
    opts?: { cursor?: string; limit?: number; since?: number; until?: number; pageNumber?: number },
  ): Promise<{ customers: PancakeCustomer[]; nextCursor: string | null; total: number | null }> {
    const until = opts?.until ?? Math.floor(Date.now() / 1000);
    const since = opts?.since ?? until - 90 * 24 * 3600;
    const pageNumber = opts?.pageNumber ?? 1;
    // Pancake hay 500 nếu page_size lớn / tải nặng — giữ ≤ 50
    const pageSize = Math.min(opts?.limit ?? 50, 50);
    const params: Record<string, string | number> = {
      page_access_token: pageAccessToken,
      since,
      until,
      page_number: pageNumber,
      page_size: pageSize,
    };

    const url = `${PANCAKE_BASE}/api/public_api/v1/pages/${encodeURIComponent(pageId)}/page_customers`;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await axios.get(url, { params, timeout: 45_000 });
        const body = res.data as { success?: boolean; message?: string; total?: number };
        if (body && typeof body === 'object' && body.success === false) {
          const err = new Error(body.message || 'Pancake page_customers failed') as Error & {
            response?: { status?: number; data?: unknown };
          };
          err.response = { status: 400, data: body };
          throw err;
        }
        const normalized = this.normalizeCustomersResponse(res.data);
        const total = typeof body.total === 'number' ? body.total : null;
        const nextCursor =
          total != null && pageNumber * pageSize < total ? String(pageNumber + 1) : null;
        return { ...normalized, nextCursor, total };
      } catch (e) {
        lastErr = e;
        const status = (e as AxiosError).response?.status;
        const msg = String((e as Error)?.message || '');
        const retryable = status === 500 || status === 502 || status === 503 || /timeout/i.test(msg);
        this.logger.warn(
          `listCustomers page=${pageId} page_number=${pageNumber} attempt=${attempt} status=${status ?? 'n/a'} ${msg}`,
        );
        if (!retryable || attempt === 3) break;
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Pancake page_customers failed');
  }

  private normalizeCustomersResponse(data: unknown): {
    customers: PancakeCustomer[];
    nextCursor: string | null;
  } {
    const root = (data ?? {}) as Record<string, unknown>;
    let list: unknown[] = [];
    if (Array.isArray(root.customers)) list = root.customers;
    else if (Array.isArray(root.page_customers)) list = root.page_customers;
    else if (Array.isArray(root.data)) list = root.data;

    const customers = list.map((item) => {
      const c = (item ?? {}) as Record<string, unknown>;
      const phones = collectPhonesFromPancakeRaw(c);
      const emails = normalizeStringList(c.emails);
      const notes =
        typeof c.notes === 'string'
          ? c.notes
          : c.notes != null
            ? JSON.stringify(c.notes)
            : null;
      return {
        id: String(c.id ?? c.psid ?? c.customer_id ?? ''),
        name: (c.name as string) || (c.full_name as string) || null,
        phone: phones[0] ?? null,
        phones,
        emails,
        notes,
        address: collectAddressFromPancakeRaw(c),
        gender: (c.gender as string) || null,
        psid: c.psid != null ? String(c.psid) : null,
        customerId: c.customer_id != null ? String(c.customer_id) : null,
        threadId:
          c.thread_id != null
            ? String(c.thread_id)
            : c.conversation_id != null
              ? String(c.conversation_id)
              : c.current_conversation_id != null
                ? String(c.current_conversation_id)
                : null,
        lastMessage: pickCustomerSnippet(c),
        conversationType: normalizePancakeConversationType(
          c.conversation_type || c.type || c.thread_type || c.origin,
        ),
        updatedAt: (c.updated_at as string) || (c.inserted_at as string) || null,
        raw: { ...c, _phones: phones },
      } satisfies PancakeCustomer;
    });

    return { customers, nextCursor: null };
  }

  private normalizePage(
    p: Record<string, unknown>,
    category?: string,
  ): PancakePage {
    const cat = category || (p.is_activated === false ? 'inactivated' : 'activated');
    return {
      id: String(p.id ?? p.page_id ?? ''),
      name: (p.name as string) ?? (p.page_name as string) ?? null,
      platform: (p.platform as string) ?? null,
      roleInPage: (p.role_in_page as string) ?? null,
      isActivated: cat === 'activated' ? true : Boolean(p.is_activated),
      username: (p.username as string) ?? null,
      category: cat,
      raw: p,
    };
  }

  private normalizeConversationsResponse(
    data: unknown,
    forcedType?: string,
  ): {
    conversations: PancakeConversation[];
    nextCursor: string | null;
    raw: unknown;
  } {
    const root = (data ?? {}) as Record<string, unknown>;
    let list: unknown[] = [];
    if (Array.isArray(root.conversations)) list = root.conversations;
    else if (Array.isArray(root.data)) list = root.data;
    else if (Array.isArray((root.data as Record<string, unknown> | undefined)?.conversations)) {
      list = (root.data as Record<string, unknown>).conversations as unknown[];
    } else if (Array.isArray(root)) list = root as unknown[];

    const conversations = list.map((item) => {
      const c = (item ?? {}) as Record<string, unknown>;
      const customer = (c.customers as Record<string, unknown>[] | undefined)?.[0] ??
        (c.customer as Record<string, unknown> | undefined) ??
        {};
      const pageCustomer =
        (c.page_customer as Record<string, unknown> | undefined) ?? {};
      const last =
        (c.last_message as Record<string, unknown> | undefined) ??
        (c.snippet as Record<string, unknown> | undefined) ??
        {};
      const lastTextRaw =
        (typeof c.last_message === 'string' ? c.last_message : null) ||
        (typeof last.message === 'string' ? last.message : null) ||
        (typeof last.text === 'string' ? last.text : null) ||
        (typeof last.original_message === 'string' ? last.original_message : null) ||
        (typeof c.snippet === 'string' ? c.snippet : null) ||
        null;
      const lastTextClean = lastTextRaw ? stripHtml(lastTextRaw) : null;
      const lastImageUrl =
        extractMessageAttachments(last, lastTextRaw).find(
          (a) =>
            /image|photo|sticker|gif/i.test(a.type || '') ||
            /\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i.test(a.url) ||
            /fbcdn|scontent|cdninstagram|tiktokcdn/i.test(a.url),
        )?.url || null;
      const lastText =
        lastTextClean && isFacebookMarketingNoise(lastTextClean)
          ? lastImageUrl
          : lastTextClean &&
              !isAttachmentPlaceholder(lastTextClean) &&
              !isExpiredMessageText(lastTextClean)
            ? lastTextClean
            : lastImageUrl || extractAttachmentTemplateText(last) || null;
      const tagsRaw = c.tags ?? c.tag_ids ?? c.tag_names ?? [];
      const tags = Array.isArray(tagsRaw)
        ? tagsRaw
            .map((t) =>
              typeof t === 'string'
                ? t
                : String(
                    (t as Record<string, unknown>)?.name ??
                      (t as Record<string, unknown>)?.text ??
                      t,
                  ),
            )
            .filter((t) => t && t !== 'undefined')
        : [];
      const type =
        normalizePancakeConversationType(
          forcedType ||
            c.type ||
            c.conversation_type ||
            c.thread_type ||
            c.message_type ||
            c.origin ||
            c.source,
        ) ||
        (forcedType ? normalizePancakeConversationType(forcedType) : null);
      return {
        id: String(c.id ?? c.conversation_id ?? ''),
        customerName:
          (customer.name as string) ||
          ((c.from as Record<string, unknown> | undefined)?.name as string) ||
          (c.from_name as string) ||
          (c.customer_name as string) ||
          (pageCustomer.name as string) ||
          null,
        customerId:
          (customer.id != null ? String(customer.id) : null) ||
          (pageCustomer.id != null ? String(pageCustomer.id) : null) ||
          (customer.psid != null ? String(customer.psid) : null) ||
          (pageCustomer.psid != null ? String(pageCustomer.psid) : null) ||
          (customer.fb_id != null ? String(customer.fb_id) : null) ||
          (c.customer_id != null ? String(c.customer_id) : null) ||
          ((c.from as Record<string, unknown> | undefined)?.id != null
            ? String((c.from as Record<string, unknown>).id)
            : null) ||
          null,
        type,
        lastMessage: lastText,
        updatedAt:
          (c.updated_at as string) ||
          (c.last_message_at as string) ||
          (c.inserted_at as string) ||
          (c.updated_time as string) ||
          null,
        tags,
        raw: c,
      } satisfies PancakeConversation;
    });

    const lastId = conversations.length
      ? conversations[conversations.length - 1]?.id
      : null;
    const nextCursor =
      (root.cursor as string) ||
      (root.next_cursor as string) ||
      (root.last_conversation_id as string) ||
      ((root.paging as Record<string, unknown> | undefined)?.cursors as Record<string, string> | undefined)
        ?.after ||
      (conversations.length >= 20 ? lastId : null);

    return { conversations, nextCursor, raw: data };
  }

  private normalizeMessagesResponse(data: unknown): {
    messages: PancakeMessage[];
    nextCursor: string | null;
    raw: unknown;
  } {
    const root = (data ?? {}) as Record<string, unknown>;
    let list: unknown[] = [];
    if (Array.isArray(root.messages)) list = root.messages;
    else if (Array.isArray(root.data)) list = root.data;
    else if (Array.isArray((root.data as Record<string, unknown> | undefined)?.messages)) {
      list = (root.data as Record<string, unknown>).messages as unknown[];
    }

    const messages = list.map((item, idx) => {
      const m = (item ?? {}) as Record<string, unknown>;
      const from = (m.from as Record<string, unknown> | undefined) ?? {};
      const rawText = pickPancakeMessageRawText(m);
      const textRaw = rawText ? stripHtml(rawText) : null;
      const attachments = extractMessageAttachments(m, rawText);
      const templateText = extractAttachmentTemplateText(m);
      const expired = isExpiredMessageText(textRaw) || isExpiredMessageText(templateText);
      const text =
        expired
          ? textRaw && !isAttachmentPlaceholder(textRaw)
            ? textRaw
            : 'Tin nhắn đã hết hạn'
          : textRaw && !isAttachmentPlaceholder(textRaw)
            ? textRaw
            : templateText && !isAttachmentPlaceholder(templateText)
              ? templateText
              : null;
      const fromId = (from.id as string) || (m.from_id as string) || null;
      const pageIdOfMsg = m.page_id != null ? String(m.page_id) : null;
      const isFromPage = Boolean(
        m.is_page_reply ||
          m.from_page ||
          m.type === 'page' ||
          from.is_page ||
          from.ai_generated ||
          (pageIdOfMsg && fromId && fromId === pageIdOfMsg),
      );
      const createdAt =
        (m.inserted_at as string) ||
        (m.created_at as string) ||
        (m.created_time as string) ||
        null;
      return {
        id: String(m.id ?? m.message_id ?? '').trim() || `pancake-${idx}-${createdAt || 'na'}`,
        message: text && isAttachmentPlaceholder(text) ? null : text,
        fromId,
        fromName: (from.name as string) || (m.from_name as string) || null,
        createdAt,
        isFromPage,
        attachments,
        raw: m,
      } satisfies PancakeMessage;
    });

    const nextCursor =
      (root.cursor as string) ||
      (root.next_cursor as string) ||
      ((root.paging as Record<string, unknown> | undefined)?.cursors as Record<string, string> | undefined)
        ?.after ||
      null;

    return { messages, nextCursor, raw: data };
  }
}

function isFacebookAdIdLike(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  return /^\d{10,20}$/.test(t);
}

function isAdReferralNoiseText(text: string | null | undefined): boolean {
  if (!text) return false;
  return /đã trả lời một quảng cáo|replied to (?:your|an?) ad|trả lời qua quảng cáo|qua quảng cáo trên facebook|ตอบกลับโฆษณ|ตอบผ่านโฆษณ|ผ่านโฆษณ|จากโฆษณ/i.test(
    text,
  );
}

export function isFacebookMarketingNoise(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (
    /^ข้อเสนอและประกาศ$|^ưu đãi và thông báo$|^offers and announcements$/i.test(t)
  ) {
    return true;
  }
  return /muốn gửi tin nhắn cho bạn|tin nhắn quảng cáo|promotional message|advertising message|wants to send you a message|facebook\.com\/help\/messenger|messenger-app\/564030381383143|this (may|might) be (an? )?(ad|advert)|ต้องการส่งข้อความถึงคุณ|ข้อความโฆษณา/i.test(
    t,
  );
}

function isAdJunkAttachment(url: string, name?: string | null): boolean {
  const label = (name || '').trim();
  if (isFacebookAdIdLike(label)) return true;
  if (/facebook\.com|fb\.com|fb\.me/i.test(url) && !/fbcdn|scontent/i.test(url)) return true;
  try {
    const base = decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean).pop() || '';
    if (isFacebookAdIdLike(base)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function tidyPancakeMessages(messages: PancakeMessage[]): PancakeMessage[] {
  const cleaned = messages.map((m) => {
    const attachments = (m.attachments ?? []).filter((a) => !isAdJunkAttachment(a.url, a.name));
    let message = m.message?.trim() || null;
    if (message && isFacebookMarketingNoise(message)) {
      return { ...m, message: null, attachments: [] };
    }
    if (message && (isFacebookAdIdLike(message) || isAdReferralNoiseText(message))) {
      message = attachments.length ? null : 'Khách đã trả lời một quảng cáo';
    }
    return { ...m, message, attachments };
  });

  const sorted = [...cleaned].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });

  const out: PancakeMessage[] = [];
  const seenIds = new Set<string>();
  for (const m of sorted) {
    if (m.id && seenIds.has(m.id)) continue;
    if (m.id) seenIds.add(m.id);

    const text = (m.message || '').trim();
    const isSystem = text === 'Khách đã trả lời một quảng cáo' || isAdReferralNoiseText(text);
    const last = out[out.length - 1];

    if (isSystem) {
      if (last && (last.message || '').trim() === 'Khách đã trả lời một quảng cáo') continue;
      out.push({ ...m, message: 'Khách đã trả lời một quảng cáo', isFromPage: false, attachments: [] });
      continue;
    }

    if (
      last &&
      text &&
      (last.message || '').trim() === text &&
      last.isFromPage === m.isFromPage
    ) {
      const t1 = last.createdAt ? new Date(last.createdAt).getTime() : 0;
      const t2 = m.createdAt ? new Date(m.createdAt).getTime() : 0;
      if (Math.abs(t2 - t1) <= 180_000) continue;
    }

    if (!text && !(m.attachments?.length)) continue;
    out.push(m);
  }
  return out;
}

function isPancakeJsonPayload(data: unknown): boolean {
  if (data == null) return false;
  if (typeof data === 'string') {
    const s = data.trim();
    return s.startsWith('{') || s.startsWith('[');
  }
  if (typeof data !== 'object') return false;
  const root = data as Record<string, unknown>;
  return (
    Array.isArray(root.messages) ||
    Array.isArray(root.conversations) ||
    Array.isArray(root.customers) ||
    Array.isArray(root.page_customers) ||
    typeof root.success === 'boolean' ||
    Array.isArray(root.data)
  );
}

function isExpiredMessageText(text: string | null | undefined): boolean {
  if (!text) return false;
  return /tin nhắn đã hết hạn|message (is )?no longer available|this content isn'?t available|hết hạn/i.test(
    text,
  );
}

function isAttachmentPlaceholder(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim().replace(/\s+/g, ' ');
  return (
    /^\[?\s*attachments?\s*\]?$/i.test(t) ||
    /^attachment$/i.test(t) ||
    /^\[(ảnh|image|photo|file|video|sticker|tệp)\]$/i.test(t) ||
    /^(tệp\s*)?đính kèm$/i.test(t) ||
    /^attached file$/i.test(t) ||
    t === '[Ảnh]' ||
    t === '[File]'
  );
}

/** Ưu tiên bản gốc hội thoại (TH/JP…) — tránh message đã bị dịch/lẫn locale CRM. */
function pickPancakeMessageRawText(m: Record<string, unknown>): string | null {
  const candidates = [
    m.original_message,
    m.original_text,
    m.message,
    m.text,
    m.content,
    m.body,
    m.snippet,
  ]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);

  if (!candidates.length) return null;

  const score = (s: string) => {
    let n = 0;
    // Thai / CJK / Hangul → ngôn ngữ khách thị trường HuyK
    if (/[\u0E00-\u0E7F]/.test(s)) n += 5;
    if (/[\u3040-\u30ff\u3400-\u9fff]/.test(s)) n += 5;
    if (/[\uac00-\ud7af]/.test(s)) n += 4;
    // Bản dịch/lẫn Việt trong hội thoại Thái thường kém điểm
    if (/đã\s*gửi\s*khoản\s*thanh\s*toán|trị\s*giá|địa\s*chỉ|hội\s*thoại/i.test(s) && /[\u0E00-\u0E7F]/.test(s)) {
      n -= 2;
    }
    if (isAttachmentPlaceholder(s) || isFacebookAdIdLike(s)) n -= 10;
    return n;
  };

  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0] || null;
}

function extractAttachmentTemplateText(m: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim() && !isAttachmentPlaceholder(v) && !isFacebookAdIdLike(v)) {
      parts.push(v.trim());
    }
  };
  const walk = (node: unknown, depth = 0) => {
    if (!node || depth > 5) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    push(o.title);
    push(o.subtitle);
    push(o.description);
    push(o.caption);
    push(o.name);
    const payload = o.payload as Record<string, unknown> | undefined;
    if (payload) {
      push(payload.title);
      push(payload.subtitle);
      push(payload.text);
    }
    for (const key of ['attachments', 'attachment', 'elements', 'cards', 'data', 'contents']) {
      if (o[key] != null) walk(o[key], depth + 1);
    }
  };
  walk(m.attachments);
  walk(m.attachment);
  walk(m.contents);
  return parts.length ? [...new Set(parts)].join('\n') : null;
}

function extractMessageAttachments(
  m: Record<string, unknown>,
  rawText: string | null,
): Array<{ url: string; type: string | null; name: string | null }> {
  const out: Array<{ url: string; type: string | null; name: string | null }> = [];
  const seen = new Set<string>();
  const add = (url?: unknown, type?: unknown, name?: unknown) => {
    if (typeof url !== 'string') return;
    const u = url.trim().replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
    // bỏ qua pixel / tracking nhỏ
    if (/pixel|spacer|1x1|s\.facebook\.com\/l\.php/i.test(u)) return;
    seen.add(u);
    const looksImage =
      /\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i.test(u) ||
      /fbcdn|scontent|cdninstagram|tiktokcdn|pancake|pages\.fm/i.test(u);
    const typeStr = typeof type === 'string' ? type : null;
    const isVideo = typeStr ? /video/i.test(typeStr) : /\.(mp4|mov|webm)(\?|$)/i.test(u);
    const placeholderName =
      typeof name === 'string' && /^(tệp\s*)?đính kèm$|^attachment$/i.test(name.trim())
        ? null
        : typeof name === 'string'
          ? name
          : null;
    out.push({
      url: u,
      type: isVideo ? 'video' : looksImage ? 'image' : typeStr,
      name: placeholderName,
    });
  };

  const walk = (node: unknown, depth = 0) => {
    if (!node || depth > 6) return;
    if (typeof node === 'string') {
      const trimmed = node.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          walk(JSON.parse(trimmed), depth + 1);
        } catch {
          add(trimmed);
        }
        return;
      }
      add(trimmed);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    add(
      o.url ||
        o.src ||
        o.image_url ||
        o.photo_url ||
        o.media_url ||
        o.preview_url ||
        o.attachment_url ||
        o.origin_url ||
        o.cdn_url ||
        o.thumb_url ||
        o.picture ||
        o.image ||
        o.href,
      o.type || o.mime_type,
      o.name || o.filename || o.file_name || o.title,
    );
    const imageData = o.image_data as Record<string, unknown> | undefined;
    add(imageData?.url || imageData?.preview_url, 'image');
    const media = o.media as Record<string, unknown> | undefined;
    const mediaImage = media?.image as Record<string, unknown> | undefined;
    add(mediaImage?.src || mediaImage?.url || media?.url || media?.src, o.type || 'image');
    const payload = o.payload as Record<string, unknown> | undefined;
    if (payload) {
      add(payload.url || payload.src || payload.image_url, o.type || payload.type, payload.name || payload.title);
      const sticker = payload.sticker as Record<string, unknown> | undefined;
      add(sticker?.url || sticker?.image_url, 'sticker');
      walk(payload.attachments, depth + 1);
      walk(payload.elements, depth + 1);
    }
    const target = o.target as Record<string, unknown> | undefined;
    add(target?.url, o.type);
    add(o.file_url, o.type, o.file_name as string | undefined);
    add(o.sticker_url, 'sticker');
    if (typeof o.sticker === 'string') add(o.sticker, 'sticker');
    for (const key of [
      'attachments',
      'attachment',
      'files',
      'photos',
      'images',
      'media',
      'contents',
      'data',
      'elements',
      'shares',
      'share',
      'story',
      'message_attachments',
    ]) {
      if (o[key] != null) walk(o[key], depth + 1);
    }
  };

  walk(m.attachments);
  walk(m.attachment);
  walk(m.files);
  walk(m.photos);
  walk(m.images);
  walk(m.media);
  walk(m.contents);
  walk(m.shares);
  walk(m.message_attachments);
  // FB-style { data: [...] }
  if (m.attachments && typeof m.attachments === 'object' && !Array.isArray(m.attachments)) {
    walk((m.attachments as Record<string, unknown>).data);
  }
  add(m.photo_url || m.image_url || oUrl(m), m.type);
  if (typeof m.type === 'string' && /photo|image|sticker|gif|file|video|audio|share/i.test(m.type)) {
    add(m.src || m.url || (m.payload as Record<string, unknown> | undefined)?.url, m.type);
  }

  if (rawText) {
    for (const match of rawText.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
      add(match[1], 'image');
    }
    for (const match of rawText.matchAll(
      /https?:\/\/[^\s"'<>]+(?:\.(?:jpg|jpeg|png|gif|webp|bmp)|fbcdn|scontent)[^\s"'<>]*/gi,
    )) {
      add(match[0], 'image');
    }
  }

  return out;
}

function oUrl(m: Record<string, unknown>): string | undefined {
  return typeof m.url === 'string' ? m.url : undefined;
}

function pickCustomerSnippet(c: Record<string, unknown>): string | null {
  const lastObj =
    (c.last_message as Record<string, unknown> | undefined) ||
    (c.recent_message as Record<string, unknown> | undefined) ||
    {};
  const raw =
    (typeof c.last_message === 'string' ? c.last_message : null) ||
    (typeof lastObj.original_message === 'string' ? lastObj.original_message : null) ||
    (typeof lastObj.message === 'string' ? lastObj.message : null) ||
    (typeof lastObj.text === 'string' ? lastObj.text : null) ||
    (typeof c.snippet === 'string' ? c.snippet : null) ||
    (typeof c.last_content === 'string' ? c.last_content : null) ||
    null;
  const lastImageUrl =
    extractMessageAttachments(lastObj, raw).find(
      (a) =>
        /image|photo|sticker|gif/i.test(a.type || '') ||
        /\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i.test(a.url) ||
        /fbcdn|scontent|cdninstagram|tiktokcdn/i.test(a.url),
    )?.url || null;
  if (!raw) return lastImageUrl;
  const cleaned = stripHtml(raw);
  if (!cleaned) return lastImageUrl;
  if (isFacebookMarketingNoise(cleaned)) return lastImageUrl;
  if (isAttachmentPlaceholder(cleaned)) return lastImageUrl;
  if (isExpiredMessageText(cleaned)) return 'Tin nhắn đã hết hạn';
  return cleaned;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim());
    else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const email = o.email ?? o.value ?? o.address;
      if (email != null && String(email).trim()) out.push(String(email).trim());
    }
  }
  return [...new Set(out)];
}

/** Chuẩn hoá loại hội thoại Pancake → INBOX | COMMENT. */
export function normalizePancakeConversationType(raw: unknown): string | null {
  if (raw == null) return null;
  const t = String(raw).trim().toLowerCase();
  if (!t) return null;
  if (
    t.includes('comment') ||
    t === 'feed' ||
    t === 'post' ||
    t === 'rate' ||
    t === 'rating' ||
    t === 'review'
  ) {
    return 'COMMENT';
  }
  if (
    t.includes('inbox') ||
    t.includes('message') ||
    t === 'messenger' ||
    t === 'chat' ||
    t === 'dm' ||
    t === 'private' ||
    t === 'private_reply' ||
    t.includes('conversation') ||
    t === 'thread'
  ) {
    return 'INBOX';
  }
  return 'INBOX';
}
