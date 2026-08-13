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
    const token =
      (data.page_access_token as string | undefined) ||
      (data.access_token as string | undefined) ||
      ((data.data as Record<string, unknown> | undefined)?.page_access_token as
        | string
        | undefined);
    if (!token) {
      this.logger.warn(`generatePageAccessToken: unexpected payload keys=${Object.keys(data)}`);
      throw new Error('Pancake không trả page_access_token');
    }
    return token;
  }

  async listConversations(
    pageId: string,
    pageAccessToken: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<{ conversations: PancakeConversation[]; nextCursor: string | null; raw: unknown }> {
    const params: Record<string, string | number> = {
      page_access_token: pageAccessToken,
    };
    if (opts?.cursor) params.cursor = opts.cursor;
    if (opts?.limit) params.limit = opts.limit;

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
        const normalized = this.normalizeConversationsResponse(res.data);
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
          return normalized;
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
        threadId: c.thread_id != null ? String(c.thread_id) : null,
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

  private normalizeConversationsResponse(data: unknown): {
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
      const last =
        (c.last_message as Record<string, unknown> | undefined) ??
        (c.snippet as Record<string, unknown> | undefined) ??
        {};
      const lastText =
        (typeof c.last_message === 'string' ? c.last_message : null) ||
        (last.message as string) ||
        (last.text as string) ||
        (c.snippet as string) ||
        null;
      const tagsRaw = c.tags ?? c.tag_ids ?? [];
      const tags = Array.isArray(tagsRaw)
        ? tagsRaw.map((t) =>
            typeof t === 'string' ? t : String((t as Record<string, unknown>)?.name ?? t),
          )
        : [];
      return {
        id: String(c.id ?? c.conversation_id ?? ''),
        customerName:
          (customer.name as string) ||
          ((c.from as Record<string, unknown> | undefined)?.name as string) ||
          (c.from_name as string) ||
          (c.customer_name as string) ||
          ((c.page_customer as Record<string, unknown> | undefined)?.name as string) ||
          null,
        customerId:
          (customer.id as string) ||
          (customer.psid as string) ||
          (customer.fb_id as string) ||
          (c.customer_id as string) ||
          ((c.from as Record<string, unknown> | undefined)?.id as string) ||
          null,
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

    const nextCursor =
      (root.cursor as string) ||
      (root.next_cursor as string) ||
      ((root.paging as Record<string, unknown> | undefined)?.cursors as Record<string, string> | undefined)
        ?.after ||
      null;

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

    const messages = list.map((item) => {
      const m = (item ?? {}) as Record<string, unknown>;
      const from = (m.from as Record<string, unknown> | undefined) ?? {};
      const rawText =
        (typeof m.original_message === 'string' && m.original_message.trim()
          ? m.original_message
          : null) ||
        (typeof m.message === 'string' ? m.message : null) ||
        (typeof m.text === 'string' ? m.text : null) ||
        (typeof m.content === 'string' ? m.content : null) ||
        null;
      const text = rawText ? stripHtml(rawText) : null;
      const attachments = extractMessageAttachments(m, rawText);
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
      return {
        id: String(m.id ?? m.message_id ?? ''),
        message: text && text !== '[Attachment]' ? text : text,
        fromId,
        fromName: (from.name as string) || (m.from_name as string) || null,
        createdAt:
          (m.inserted_at as string) ||
          (m.created_at as string) ||
          (m.created_time as string) ||
          null,
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

function extractMessageAttachments(
  m: Record<string, unknown>,
  rawText: string | null,
): Array<{ url: string; type: string | null; name: string | null }> {
  const out: Array<{ url: string; type: string | null; name: string | null }> = [];
  const seen = new Set<string>();
  const add = (url?: unknown, type?: unknown, name?: unknown) => {
    if (typeof url !== 'string') return;
    const u = url.trim();
    if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
    // bỏ qua pixel / tracking nhỏ
    if (/pixel|spacer|1x1/i.test(u)) return;
    seen.add(u);
    out.push({
      url: u,
      type: typeof type === 'string' ? type : null,
      name: typeof name === 'string' ? name : null,
    });
  };

  const walk = (node: unknown, depth = 0) => {
    if (!node || depth > 4) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    add(o.url || o.src || o.image_url || o.photo_url || o.media_url || o.preview_url, o.type || o.mime_type, o.name || o.filename);
    add((o.image_data as Record<string, unknown> | undefined)?.url, 'image');
    add((o.payload as Record<string, unknown> | undefined)?.url, o.type);
    for (const key of ['attachments', 'attachment', 'files', 'photos', 'images', 'media', 'contents']) {
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
  add(m.photo_url || m.image_url || oUrl(m), m.type);
  if (typeof m.type === 'string' && /photo|image|sticker|gif/i.test(m.type)) {
    add(m.src || m.url || (m.payload as Record<string, unknown> | undefined)?.url, m.type);
  }

  if (rawText) {
    for (const match of rawText.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
      add(match[1], 'image');
    }
    for (const match of rawText.matchAll(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|gif|webp|bmp)(?:\?[^\s"'<>]*)?/gi)) {
      add(match[0], 'image');
    }
  }

  return out;
}

function oUrl(m: Record<string, unknown>): string | undefined {
  return typeof m.url === 'string' ? m.url : undefined;
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
