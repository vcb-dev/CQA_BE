import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PancakeClient, type PancakePage } from './pancake.client';
import {
  collectAddressFromPancakeRaw,
  collectPhonesFromPancakeRaw,
  extractAddressFromText,
  extractPhonesFromMessages,
  extractPhonesFromText,
} from './pancake-phone.util';
import { detectOrderClosedFromTexts } from './pancake-order-detect.util';

function decodePancakeJwt(token: string): {
  pancakeUserId: string;
  userName: string | null;
  exp: Date | null;
} {
  try {
    const parts = token.split('.');
    if (parts.length < 2) throw new Error('not jwt');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      uid?: string;
      pancake_id?: string;
      name?: string;
      fb_name?: string;
      exp?: number;
    };
    const pancakeUserId = String(payload.pancake_id || payload.uid || 'default');
    return {
      pancakeUserId,
      userName: payload.name || payload.fb_name || null,
      exp: payload.exp ? new Date(payload.exp * 1000) : null,
    };
  } catch {
    return { pancakeUserId: 'default', userName: null, exp: null };
  }
}

function maskToken(token: string): string {
  if (token.length <= 12) return '***';
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

@Injectable()
export class PancakeService {
  private readonly logger = new Logger(PancakeService.name);
  /**
   * Cache list pages in-memory + DB (session.metadata.pages).
   * Pancake /api/v1/pages rất dễ 429 — ưu tiên cache, chỉ gọi live khi hết TTL.
   */
  private pagesCache: {
    tokenKey: string;
    at: number;
    pages: PancakePage[];
  } | null = null;
  /** Default 10 phút — tránh spam list pages khi FE reload / Nest restart. */
  private readonly pagesCacheTtlMs = Number(process.env.PANCAKE_PAGES_CACHE_MS || 600_000);
  /** Dedup: status + pages gọi cùng lúc chỉ 1 request lên Pancake. */
  private pagesInFlight: Map<string, Promise<PancakePage[]>> = new Map();

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: PancakeClient,
  ) {}

  /** Optional bootstrap from env if DB has no session yet. */
  private envBootstrapToken(): string | null {
    const t = process.env.PANCAKE_USER_ACCESS_TOKEN?.trim();
    return t || null;
  }

  private tokenKey(token: string) {
    return token.slice(-24);
  }

  private async persistPagesSnapshot(token: string, pages: PancakePage[]) {
    try {
      const session = await this.prisma.pancakeOAuthSession.findFirst({
        where: { userAccessToken: token },
        orderBy: { updatedAt: 'desc' },
      });
      if (!session) return;
      const prev = (session.metadata ?? {}) as Record<string, unknown>;
      await this.prisma.pancakeOAuthSession.update({
        where: { id: session.id },
        data: {
          metadata: {
            ...prev,
            activatedPageCount: pages.length,
            pagesCachedAt: new Date().toISOString(),
            pages: pages.map((p) => ({
              id: p.id,
              name: p.name,
              platform: p.platform,
              roleInPage: p.roleInPage,
              username: p.username,
              isActivated: true,
              category: 'activated',
            })),
          } as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      this.logger.warn(`persist pages snapshot failed: ${(e as Error).message}`);
    }
  }

  private async loadPagesFromDb(token: string): Promise<PancakePage[] | null> {
    const session = await this.prisma.pancakeOAuthSession.findFirst({
      where: { userAccessToken: token },
      orderBy: { updatedAt: 'desc' },
    });
    const meta = (session?.metadata ?? {}) as {
      pages?: Array<{
        id?: string;
        name?: string | null;
        platform?: string | null;
        roleInPage?: string | null;
        username?: string | null;
        isActivated?: boolean;
        category?: string | null;
      }>;
    };
    if (Array.isArray(meta.pages) && meta.pages.length) {
      return meta.pages
        .filter((p) => p?.id)
        .filter((p) => p.category !== 'inactivated' && p.isActivated !== false)
        .map((p) => ({
          id: String(p.id),
          name: p.name ?? null,
          platform: p.platform ?? null,
          roleInPage: p.roleInPage ?? null,
          username: p.username ?? null,
          isActivated: true,
          category: 'activated',
        }));
    }

    // Fallback: page configs đã generate token trước đó
    const configs = await this.prisma.pancakePageConfig.findMany({
      where: session?.tenantId ? { tenantId: session.tenantId } : {},
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });
    if (!configs.length) return null;
    return configs.map((c) => ({
      id: c.pageId,
      name: c.pageName,
      platform: c.platform,
      roleInPage: null,
      username: null,
      isActivated: true,
      category: 'activated',
    }));
  }

  private async listPagesCached(token: string): Promise<PancakePage[]> {
    const tokenKey = this.tokenKey(token);
    const now = Date.now();
    if (
      this.pagesCache &&
      this.pagesCache.tokenKey === tokenKey &&
      now - this.pagesCache.at < this.pagesCacheTtlMs
    ) {
      return this.pagesCache.pages;
    }

    const existing = this.pagesInFlight.get(tokenKey);
    if (existing) return existing;

    const job = (async () => {
      try {
        const { activated } = await this.client.listPages(token);
        this.pagesCache = { tokenKey, at: Date.now(), pages: activated };
        void this.persistPagesSnapshot(token, activated);
        return activated;
      } catch (e) {
        const status = (e as { response?: { status?: number } })?.response?.status;
        if (this.pagesCache?.tokenKey === tokenKey && this.pagesCache.pages.length) {
          this.logger.warn(
            `Pancake listPages failed status=${status} — dùng memory cache (${this.pagesCache.pages.length} pages)`,
          );
          return this.pagesCache.pages;
        }
        const fromDb = await this.loadPagesFromDb(token);
        if (fromDb?.length) {
          this.pagesCache = { tokenKey, at: Date.now(), pages: fromDb };
          this.logger.warn(
            `Pancake listPages failed status=${status} — dùng DB snapshot (${fromDb.length} pages)`,
          );
          return fromDb;
        }
        throw e;
      } finally {
        this.pagesInFlight.delete(tokenKey);
      }
    })();

    this.pagesInFlight.set(tokenKey, job);
    return job;
  }

  async connect(accessToken: string, tenantId?: string | null) {
    const token = accessToken?.trim();
    if (!token) throw new BadRequestException('accessToken bắt buộc');

    this.pagesCache = null;

    let pages: PancakePage[];
    try {
      pages = await this.listPagesCached(token);
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      this.logger.warn(`connect listPages failed: status=${status} ${(e as Error).message}`);
      if (status === 429) {
        throw new BadRequestException(
          'Pancake đang giới hạn tần suất (429). Đợi khoảng 1 phút rồi thử lại.',
        );
      }
      throw new BadRequestException('User Access Token không hợp lệ hoặc Pancake từ chối');
    }

    const decoded = decodePancakeJwt(token);
    const session = await this.prisma.pancakeOAuthSession.upsert({
      where: { pancakeUserId: decoded.pancakeUserId },
      create: {
        pancakeUserId: decoded.pancakeUserId,
        userName: decoded.userName,
        userAccessToken: token,
        tokenExpiresAt: decoded.exp,
        tenantId: tenantId || null,
        metadata: { activatedPageCount: pages.length } as Prisma.InputJsonValue,
      },
      update: {
        userName: decoded.userName,
        userAccessToken: token,
        tokenExpiresAt: decoded.exp,
        tenantId: tenantId || undefined,
        metadata: { activatedPageCount: pages.length } as Prisma.InputJsonValue,
      },
    });

    return {
      connected: true,
      userName: session.userName,
      activatedPageCount: pages.length,
      tokenMasked: maskToken(token),
      tokenExpiresAt: session.tokenExpiresAt,
    };
  }

  async getSession(tenantId?: string | null) {
    const where = tenantId
      ? { OR: [{ tenantId }, { tenantId: null }] }
      : {};
    let session = await this.prisma.pancakeOAuthSession.findFirst({
      where,
      orderBy: { updatedAt: 'desc' },
    });

    const envToken = this.envBootstrapToken();
    // Ưu tiên token trong .env: auto-connect / đồng bộ nếu DB chưa có hoặc token khác
    if (envToken && (!session || session.userAccessToken !== envToken)) {
      await this.connect(envToken, tenantId);
      session = await this.prisma.pancakeOAuthSession.findFirst({
        where,
        orderBy: { updatedAt: 'desc' },
      });
    }
    return session;
  }

  async requireUserToken(tenantId?: string | null): Promise<{
    token: string;
    sessionId: string;
    userName: string | null;
  }> {
    const session = await this.getSession(tenantId);
    if (!session?.userAccessToken) {
      throw new UnauthorizedException(
        'Chưa kết nối Pancake. Dán User Access Token hoặc cấu hình PANCAKE_USER_ACCESS_TOKEN.',
      );
    }
    return {
      token: session.userAccessToken,
      sessionId: session.id,
      userName: session.userName,
    };
  }

  async status(tenantId?: string | null) {
    const session = await this.getSession(tenantId);
    if (!session) {
      return {
        connected: false,
        userName: null,
        activatedPageCount: 0,
        tokenMasked: null,
        tokenExpiresAt: null,
        updatedAt: null,
        fromEnv: Boolean(this.envBootstrapToken()),
      };
    }
    const meta = (session.metadata ?? {}) as {
      activatedPageCount?: number;
      pages?: unknown[];
    };
    // Không gọi Pancake live ở đây — tránh 429 khi FE load status + pages cùng lúc.
    let activatedPageCount =
      meta.activatedPageCount ??
      (Array.isArray(meta.pages) ? meta.pages.length : 0) ??
      0;
    if (
      this.pagesCache &&
      this.pagesCache.tokenKey === this.tokenKey(session.userAccessToken)
    ) {
      activatedPageCount = this.pagesCache.pages.length;
    }
    return {
      connected: true,
      userName: session.userName,
      activatedPageCount,
      tokenMasked: maskToken(session.userAccessToken),
      tokenExpiresAt: session.tokenExpiresAt,
      updatedAt: session.updatedAt,
      fromEnv: Boolean(this.envBootstrapToken()),
    };
  }

  async listPages(tenantId?: string | null) {
    const { token } = await this.requireUserToken(tenantId);
    try {
      const activated = await this.listPagesCached(token);
      return {
        pages: activated.map((p) => ({
          id: p.id,
          name: p.name,
          platform: p.platform,
          roleInPage: p.roleInPage,
          username: p.username,
          isActivated: true,
          category: 'activated' as const,
        })),
        count: activated.length,
        cached: true as const,
      };
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 429) {
        throw new BadRequestException(
          'Pancake đang giới hạn tần suất (429): API list pages bị chặn tạm. Đợi 1–2 phút rồi bấm Làm mới. (Lần sau hệ thống sẽ dùng cache DB nếu đã từng tải thành công.)',
        );
      }
      throw e;
    }
  }

  /**
   * Resolve page_access_token: prefer DB cache; generate only when missing or force.
   * Regenerating invalidates previous Pancake page tokens.
   */
  async resolvePageAccessToken(
    pageId: string,
    opts?: { forceRegenerate?: boolean; tenantId?: string | null; pageMeta?: Partial<PancakePage> },
  ): Promise<{ token: string; regenerated: boolean }> {
    const pid = pageId.trim();
    if (!pid) throw new BadRequestException('pageId bắt buộc');

    if (!opts?.forceRegenerate) {
      const cached = await this.prisma.pancakePageConfig.findUnique({ where: { pageId: pid } });
      if (cached?.pageAccessToken) {
        return { token: cached.pageAccessToken, regenerated: false };
      }
    }

    const { token: userToken } = await this.requireUserToken(opts?.tenantId);
    this.logger.warn(`Generating new page_access_token for page=${pid} (invalidates old token)`);
    const pageToken = await this.client.generatePageAccessToken(pid, userToken);

    await this.prisma.pancakePageConfig.upsert({
      where: { pageId: pid },
      create: {
        pageId: pid,
        pageName: opts?.pageMeta?.name ?? null,
        platform: opts?.pageMeta?.platform ?? null,
        pageAccessToken: pageToken,
        tenantId: opts?.tenantId || null,
      },
      update: {
        pageAccessToken: pageToken,
        pageName: opts?.pageMeta?.name ?? undefined,
        platform: opts?.pageMeta?.platform ?? undefined,
        tenantId: opts?.tenantId || undefined,
      },
    });

    return { token: pageToken, regenerated: true };
  }

  private mapPancakeHttpError(e: unknown, fallback: string): never {
    const ax = e as {
      response?: { status?: number; data?: { message?: string; error?: string } };
      message?: string;
    };
    const status = ax?.response?.status;
    const pancakeMsg =
      (typeof ax?.response?.data?.message === 'string' && ax.response.data.message) ||
      (typeof ax?.response?.data?.error === 'string' && ax.response.data.error) ||
      '';
    const msg = pancakeMsg || ax?.message || fallback;
    if (status === 429) {
      throw new BadRequestException(
        'Pancake đang giới hạn tần suất (429). Đợi khoảng 1 phút rồi thử lại.',
      );
    }
    if (status === 401 || status === 403) {
      throw new BadRequestException(
        `Pancake từ chối token trang (${status}). Thử Đồng bộ lại. ${pancakeMsg}`.trim(),
      );
    }
    if (status === 500 || status === 502 || status === 503) {
      throw new BadRequestException(
        `Pancake server lỗi tạm (${status}) khi gọi page. Thử Đồng bộ lại sau vài giây.${pancakeMsg ? ` Chi tiết: ${pancakeMsg}` : ''}`,
      );
    }
    if (/timeout/i.test(msg)) {
      throw new BadRequestException('Pancake phản hồi quá chậm (timeout). Thử lại sau.');
    }
    throw new BadRequestException(
      pancakeMsg ? `${fallback}: ${pancakeMsg}` : fallback,
    );
  }

  private async withPageTokenRetry<T>(
    pageId: string,
    tenantId: string | null | undefined,
    fn: (pageToken: string) => Promise<T>,
  ): Promise<{ result: T; pageTokenRegenerated: boolean }> {
    let regenerated = false;
    let { token, regenerated: firstGen } = await this.resolvePageAccessToken(pageId, { tenantId });
    regenerated = firstGen;
    try {
      const result = await fn(token);
      return { result, pageTokenRegenerated: regenerated };
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 401 || status === 403) {
        this.logger.warn(`page token rejected for ${pageId}, regenerating`);
        try {
          const next = await this.resolvePageAccessToken(pageId, {
            forceRegenerate: true,
            tenantId,
          });
          regenerated = true;
          const result = await fn(next.token);
          return { result, pageTokenRegenerated: regenerated };
        } catch (e2) {
          this.mapPancakeHttpError(e2, `Pancake lỗi khi gọi page ${pageId}`);
        }
      }
      this.mapPancakeHttpError(e, `Pancake lỗi khi gọi page ${pageId}`);
    }
  }

  async listConversations(
    pageId: string,
    opts?: { cursor?: string; limit?: number; tenantId?: string | null },
  ) {
    const { result, pageTokenRegenerated } = await this.withPageTokenRetry(
      pageId,
      opts?.tenantId,
      (pageToken) =>
        this.client.listConversations(pageId, pageToken, {
          cursor: opts?.cursor,
          limit: opts?.limit ?? 30,
        }),
    );
    return {
      conversations: result.conversations,
      nextCursor: result.nextCursor,
      pageTokenRegenerated,
      warning: pageTokenRegenerated
        ? 'Đã tạo page_access_token mới — token cũ trên Pancake (nếu có) đã bị vô hiệu.'
        : null,
    };
  }

  /**
   * Lead theo kênh: conversations (có hội thoại) + merge profile page_customers (SĐT/email/địa chỉ).
   * Nhiều khách trên Pancake không có phone_numbers — chỉ hiện khi Pancake đã lưu hoặc trích từ tin nhắn.
   */
  async listLeads(
    pageId: string,
    opts?: { cursor?: string; limit?: number; tenantId?: string | null },
  ) {
    const pages = await this.listPages(opts?.tenantId);
    const page = pages.pages.find((p) => p.id === pageId);
    const limit = opts?.limit ?? 50;

    const { result, pageTokenRegenerated } = await this.withPageTokenRetry(
      pageId,
      opts?.tenantId,
      async (pageToken) => {
        const pageNumber = opts?.cursor ? parseInt(opts.cursor, 10) || 1 : 1;

        const [convsSettled, customersSettled] = await Promise.allSettled([
          this.client.listConversations(pageId, pageToken, { limit }),
          this.client.listCustomers(pageId, pageToken, { pageNumber, limit }),
        ]);

        const convs =
          convsSettled.status === 'fulfilled' ? convsSettled.value : null;
        const customers =
          customersSettled.status === 'fulfilled' ? customersSettled.value : null;

        if (convsSettled.status === 'rejected') {
          this.logger.warn(
            `listConversations ${pageId}: ${(convsSettled.reason as Error)?.message}`,
          );
        }
        if (customersSettled.status === 'rejected') {
          this.logger.warn(
            `listCustomers ${pageId}: ${(customersSettled.reason as Error)?.message}`,
          );
        }

        const customerByKey = new Map<
          string,
          NonNullable<typeof customers>['customers'][number]
        >();
        for (const c of customers?.customers ?? []) {
          for (const key of [c.id, c.customerId, c.psid]) {
            if (key) customerByKey.set(String(key), c);
          }
        }

        if (convs && convs.conversations.length > 0) {
          const leads = convs.conversations.map((c) => {
            const raw = c.raw || {};
            const pageCustomer =
              (raw.page_customer as Record<string, unknown> | undefined) || {};
            const firstCustomer =
              (raw.customers as Record<string, unknown>[] | undefined)?.[0] ||
              (raw.customer as Record<string, unknown> | undefined) ||
              {};
            const profile =
              customerByKey.get(String(firstCustomer.id ?? '')) ||
              customerByKey.get(String(c.customerId ?? '')) ||
              customerByKey.get(String(pageCustomer.id ?? '')) ||
              customerByKey.get(String(pageCustomer.psid ?? '')) ||
              null;

            const phones = [
              ...new Set([
                ...collectPhonesFromPancakeRaw(raw),
                ...collectPhonesFromPancakeRaw(pageCustomer),
                ...collectPhonesFromPancakeRaw(firstCustomer),
                ...(profile?.phones ?? []),
                ...extractPhonesFromText(c.lastMessage),
                ...extractPhonesFromText(
                  typeof profile?.notes === 'string' ? profile.notes : null,
                ),
              ]),
            ];

            return {
              id: String(profile?.id || firstCustomer.id || c.customerId || c.id),
              fullName: c.customerName || profile?.name || null,
              phones,
              emails: profile?.emails ?? [],
              address:
                profile?.address ||
                collectAddressFromPancakeRaw(pageCustomer) ||
                collectAddressFromPancakeRaw(firstCustomer) ||
                collectAddressFromPancakeRaw(raw) ||
                extractAddressFromText(c.lastMessage) ||
                null,
              notes: profile?.notes ?? null,
              gender: profile?.gender ?? null,
              conversationId: c.id,
              lastMessage: c.lastMessage,
              dataAt: c.updatedAt,
              hasPhone: Boolean(raw.has_phone) || phones.length > 0,
              type: (raw.type as string) || null,
            };
          });

          return {
            source: 'conversations+customers' as const,
            leads,
            nextCursor: convs.nextCursor,
            total: customers?.total ?? null,
          };
        }

        // Fallback: chỉ có page_customers
        const leads = (customers?.customers ?? []).map((c) => ({
          id: c.id,
          fullName: c.name,
          phones: c.phones,
          emails: c.emails,
          address: c.address,
          notes: c.notes,
          gender: c.gender,
          conversationId: c.threadId,
          lastMessage: null as string | null,
          dataAt: c.updatedAt,
          hasPhone: c.phones.length > 0,
          type: null as string | null,
        }));

        return {
          source: 'page_customers' as const,
          leads,
          nextCursor: customers?.nextCursor ?? null,
          total: customers?.total ?? null,
        };
      },
    );

    const withPhone = result.leads.filter((l) => l.phones.length > 0).length;

    return {
      pageId,
      pageName: page?.name ?? null,
      platform: page?.platform ?? null,
      source: result.source,
      leads: result.leads.map((l) => ({
        ...l,
        sourcePageId: pageId,
        sourcePageName: page?.name ?? null,
        platform: page?.platform ?? null,
      })),
      count: result.leads.length,
      withPhoneCount: withPhone,
      total: result.total,
      nextCursor: result.nextCursor,
      pageTokenRegenerated,
      warning: pageTokenRegenerated
        ? 'Đã tạo page_access_token mới — token cũ trên Pancake (nếu có) đã bị vô hiệu.'
        : null,
      note:
        withPhone === 0
          ? 'Pancake chưa lưu SĐT trên các lead này (phone_numbers rỗng). Mở hội thoại để xem chat — SĐT chỉ hiện nếu khách/ghi chú có số, hoặc đã lưu trên Pancake.'
          : 'Sandbox CRM lead theo kênh — chưa upsert Lead DB.',
    };
  }

  async listMessages(
    pageId: string,
    conversationId: string,
    opts?: { cursor?: string; limit?: number; tenantId?: string | null },
  ) {
    const { result, pageTokenRegenerated } = await this.withPageTokenRetry(
      pageId,
      opts?.tenantId,
      (pageToken) =>
        this.client.listMessages(pageId, conversationId, pageToken, {
          cursor: opts?.cursor,
          limit: opts?.limit ?? 50,
        }),
    );
    return {
      messages: result.messages,
      nextCursor: result.nextCursor,
      pageTokenRegenerated,
      warning: pageTokenRegenerated
        ? 'Đã tạo page_access_token mới — token cũ trên Pancake (nếu có) đã bị vô hiệu.'
        : null,
    };
  }

  async leadPreview(
    pageId: string,
    conversationId: string,
    opts?: { tenantId?: string | null },
  ) {
    const pages = await this.listPages(opts?.tenantId);
    const page = pages.pages.find((p) => p.id === pageId);
    if (!page) {
      throw new NotFoundException('Page không thuộc account đã kết nối');
    }

    const convRes = await this.listConversations(pageId, {
      limit: 50,
      tenantId: opts?.tenantId,
    });
    const conv =
      convRes.conversations.find((c) => c.id === conversationId) ??
      ({
        id: conversationId,
        customerName: null,
        customerId: null,
        lastMessage: null,
        updatedAt: null,
        tags: [],
        raw: {},
      } as const);

    const msgRes = await this.listMessages(pageId, conversationId, {
      limit: 80,
      tenantId: opts?.tenantId,
    });
    const phones = [
      ...new Set([
        ...collectPhonesFromPancakeRaw(conv.raw as Record<string, unknown>),
        ...collectPhonesFromPancakeRaw(
          ((conv.raw as Record<string, unknown> | undefined)?.page_customer as
            | Record<string, unknown>
            | undefined) ?? undefined,
        ),
        ...extractPhonesFromMessages(msgRes.messages),
      ]),
    ];
    const addressFromChat =
      collectAddressFromPancakeRaw(conv.raw as Record<string, unknown>) ||
      collectAddressFromPancakeRaw(
        ((conv.raw as Record<string, unknown> | undefined)?.page_customer as
          | Record<string, unknown>
          | undefined) ?? undefined,
      ) ||
      msgRes.messages
        .map((m) => extractAddressFromText(m.message))
        .find((a): a is string => Boolean(a)) ||
      null;

    const orderSignal = detectOrderClosedFromTexts([
      conv.lastMessage,
      ...msgRes.messages.map((m) => m.message),
    ]);

    const chatUpgrade = await this.upgradeLeadFromChatOrder({
      pageId,
      conversationId,
      customerId: conv.customerId,
      fullName: conv.customerName,
      phones,
      address: addressFromChat,
      lastMessage: conv.lastMessage || msgRes.messages[0]?.message || null,
      signal: orderSignal,
      tenantId: opts?.tenantId,
    });

    return {
      leadPreview: {
        fullName: conv.customerName,
        phones,
        address: addressFromChat,
        sourcePageId: page.id,
        sourcePageName: page.name,
        platform: page.platform,
        conversationId,
        customerId: conv.customerId,
        dataAt: conv.updatedAt || msgRes.messages[0]?.createdAt || null,
        lastMessage: conv.lastMessage || msgRes.messages[0]?.message || null,
        tags: conv.tags,
        chatHint: `Pancake page ${page.id} / conversation ${conversationId}`,
        orderSignal: {
          closed: orderSignal.closed,
          confidence: orderSignal.confidence,
          reasons: orderSignal.reasons,
        },
        leadUpgraded: chatUpgrade.upgraded,
        leadStage: chatUpgrade.stage,
        leadLabels: chatUpgrade.labels,
      },
      messages: msgRes.messages,
      pageTokenRegenerated: convRes.pageTokenRegenerated || msgRes.pageTokenRegenerated,
      warning: convRes.warning || msgRes.warning,
      note: orderSignal.closed
        ? chatUpgrade.upgraded
          ? `Phát hiện chốt đơn từ chat (${orderSignal.confidence}) — đã gắn nhãn Đã chốt.`
          : `Phát hiện chốt đơn từ chat (${orderSignal.confidence}).`
        : phones.length === 0
          ? 'Pancake chưa có SĐT trên hội thoại này. SĐT chỉ có khi khách gửi số / CS lưu trên Pancake (phone_numbers, phone_info).'
          : addressFromChat
            ? 'Đã trích SĐT + địa chỉ từ hội thoại / profile Pancake.'
            : 'Đã có SĐT. Địa chỉ chỉ có khi khách gửi / có trong đơn Pancake (recent_orders) / lives_in.',
    };
  }

  /** Lead đã lưu trong DB CRM (sau sync / webhook). */
  async listStoredLeads(
    pageId: string,
    opts?: { limit?: number; offset?: number; onlyWithPhone?: boolean; tenantId?: string | null },
  ) {
    const pages = await this.listPages(opts?.tenantId);
    const page = pages.pages.find((p) => p.id === pageId);
    const limit = Math.min(opts?.limit ?? 100, 500);
    const offset = opts?.offset ?? 0;

    const where: Prisma.PancakeLeadWhereInput = { pageId };
    if (opts?.tenantId) where.tenantId = opts.tenantId;
    if (opts?.onlyWithPhone) {
      where.NOT = { phones: { equals: [] } };
    }

    const baseWhere: Prisma.PancakeLeadWhereInput = { pageId };
    if (opts?.tenantId) baseWhere.tenantId = opts.tenantId;

    const [total, rows, withPhoneCount, conversationCount, customerCount, followCount] =
      await Promise.all([
        this.prisma.pancakeLead.count({ where: baseWhere }),
        this.prisma.pancakeLead.findMany({
          where,
          orderBy: [{ followAt: 'desc' }, { dataAt: 'desc' }, { updatedAt: 'desc' }],
          take: limit,
          skip: offset,
        }),
        this.prisma.pancakeLead.count({
          where: { ...baseWhere, NOT: { phones: { equals: [] } } },
        }),
        this.prisma.pancakeLead.count({
          where: { ...baseWhere, stage: 'conversation' },
        }),
        this.prisma.pancakeLead.count({
          where: { ...baseWhere, stage: 'customer' },
        }),
        this.prisma.pancakeLead.count({
          where: { ...baseWhere, followAt: { not: null } },
        }),
      ]);

    return {
      pageId,
      pageName: page?.name ?? rows[0]?.pageName ?? null,
      platform: page?.platform ?? rows[0]?.platform ?? null,
      source: 'db' as const,
      leads: rows.map((r) => {
        const labels = ensureDefaultLabels(r.stage, r.labels);
        if (labelsNeedPersist(r.labels ?? [], labels)) {
          void this.prisma.pancakeLead
            .update({ where: { id: r.id }, data: { labels } })
            .catch((e) =>
              this.logger.warn(`backfill labels lead=${r.id}: ${(e as Error).message}`),
            );
        }
        return {
          id: r.id,
          pancakeCustomerId: r.pancakeCustomerId,
          fullName: r.fullName,
          phones: r.phones,
          emails: r.emails,
          address: r.address,
          notes: r.notes,
          gender: r.gender,
          conversationId: r.conversationId,
          lastMessage: r.lastMessage,
          dataAt: r.dataAt?.toISOString() ?? r.updatedAt.toISOString(),
          hasPhone: r.phones.length > 0,
          type: r.conversationType,
          stage: r.stage || 'conversation',
          labels,
          followAt: r.followAt?.toISOString() ?? null,
          orderedAt: r.orderedAt?.toISOString() ?? null,
          orderRef: r.orderRef,
          sourcePageId: r.pageId,
          sourcePageName: r.pageName,
          platform: r.platform,
          leadSource: r.source,
        };
      }),
      count: rows.length,
      withPhoneCount,
      stageCounts: {
        conversation: conversationCount,
        customer: customerCount,
        follow: followCount,
      },
      total,
      nextCursor: offset + rows.length < total ? String(offset + rows.length) : null,
      pageTokenRegenerated: false,
      warning: null as string | null,
      note:
        total === 0
          ? 'Chưa có lead trong DB. Bấm Đồng bộ để kéo hội thoại từ Pancake.'
          : `Lead hội thoại: ${conversationCount} · Đã lên khách (có đơn): ${customerCount} · Có SĐT: ${withPhoneCount}.`,
    };
  }

  /**
   * Đồng bộ toàn bộ page_customers của 1 kênh vào pancake_leads.
   * Có delay để tránh 429.
   */
  async syncPageCustomers(
    pageId: string,
    opts?: { tenantId?: string | null; maxPages?: number },
  ) {
    this.logger.log(`Pancake sync START pageId=${pageId}`);
    const pages = await this.listPages(opts?.tenantId);
    const page = pages.pages.find((p) => p.id === pageId);
    if (!page) throw new NotFoundException('Page không thuộc account đã kết nối');

    const maxPages = opts?.maxPages ?? 40;
    let pageNumber = 1;
    let upserted = 0;
    let fetched = 0;
    let total: number | null = null;
    let pageTokenRegenerated = false;
    let usedConversationsFallback = false;

    try {
      while (pageNumber <= maxPages) {
        this.logger.log(
          `Pancake sync page=${pageId} fetching customers page_number=${pageNumber}/${maxPages}`,
        );
        const { result, pageTokenRegenerated: regen } = await this.withPageTokenRetry(
          pageId,
          opts?.tenantId,
          (pageToken) =>
            this.client.listCustomers(pageId, pageToken, {
              pageNumber,
              limit: 50,
            }),
        );
        pageTokenRegenerated = pageTokenRegenerated || regen;
        if (typeof result.total === 'number') total = result.total;
        if (!result.customers.length) {
          this.logger.log(
            `Pancake sync page=${pageId} empty page_number=${pageNumber} — stop`,
          );
          break;
        }

        fetched += result.customers.length;
        for (const c of result.customers) {
          if (!c.id) continue;
          await this.prisma.pancakeLead.upsert({
            where: {
              pageId_pancakeCustomerId: {
                pageId,
                pancakeCustomerId: c.id,
              },
            },
            create: {
              pageId,
              pageName: page.name,
              platform: page.platform,
              pancakeCustomerId: c.id,
              customerId: c.customerId,
              psid: c.psid,
              fullName: c.name,
              phones: c.phones,
              emails: c.emails,
              address: c.address,
              notes: c.notes,
              gender: c.gender,
              conversationId: c.threadId,
              dataAt: parseOptionalDate(c.updatedAt),
              source: 'sync',
              labels: ['follow'],
              raw: c.raw as Prisma.InputJsonValue,
              tenantId: opts?.tenantId || null,
            },
            update: {
              pageName: page.name,
              platform: page.platform,
              customerId: c.customerId ?? undefined,
              psid: c.psid ?? undefined,
              fullName: c.name,
              phones: c.phones,
              emails: c.emails,
              address: c.address || undefined,
              notes: c.notes,
              gender: c.gender ?? undefined,
              conversationId: c.threadId ?? undefined,
              dataAt: parseOptionalDate(c.updatedAt) ?? undefined,
              source: 'sync',
              raw: c.raw as Prisma.InputJsonValue,
              tenantId: opts?.tenantId || undefined,
            },
          });
          upserted += 1;
        }

        this.logger.log(
          `Pancake sync page=${pageId} page_number=${pageNumber} batch=${result.customers.length} upserted=${upserted} totalFromPancake=${total ?? '?'}`,
        );

        if (!result.nextCursor) break;
        pageNumber = parseInt(result.nextCursor, 10) || pageNumber + 1;
        await sleep(700);
      }
    } catch (e) {
      // page_customers hay 500 tạm — fallback kéo lead từ hội thoại để UI vẫn có dữ liệu
      this.logger.warn(
        `page_customers sync failed page=${pageId}: ${(e as Error).message} — fallback conversations`,
      );
      usedConversationsFallback = true;
      const { result: convs, pageTokenRegenerated: regen } = await this.withPageTokenRetry(
        pageId,
        opts?.tenantId,
        (pageToken) => this.client.listConversations(pageId, pageToken, { limit: 100 }),
      );
      pageTokenRegenerated = pageTokenRegenerated || regen;
      for (const conv of convs.conversations) {
        const raw = conv.raw || {};
        const custId =
          String(
            (raw.customers as { id?: string }[] | undefined)?.[0]?.id ||
              (raw.page_customer as { id?: string } | undefined)?.id ||
              conv.customerId ||
              conv.id,
          ) || null;
        if (!custId) continue;
        const phones = [
          ...new Set([
            ...collectPhonesFromPancakeRaw(raw),
            ...collectPhonesFromPancakeRaw(
              (raw.page_customer as Record<string, unknown> | undefined) ?? undefined,
            ),
            ...extractPhonesFromText(conv.lastMessage),
          ]),
        ];
        const address =
          collectAddressFromPancakeRaw(raw) ||
          collectAddressFromPancakeRaw(
            (raw.page_customer as Record<string, unknown> | undefined) ?? undefined,
          ) ||
          extractAddressFromText(conv.lastMessage);
        await this.prisma.pancakeLead.upsert({
          where: {
            pageId_pancakeCustomerId: { pageId, pancakeCustomerId: custId },
          },
          create: {
            pageId,
            pageName: page.name,
            platform: page.platform,
            pancakeCustomerId: custId,
            customerId: conv.customerId,
            fullName: conv.customerName,
            phones,
            address,
            conversationId: conv.id,
            lastMessage: conv.lastMessage,
            conversationType: (raw.type as string) || null,
            dataAt: parseOptionalDate(conv.updatedAt),
            source: 'sync_conversations',
            labels: ['follow'],
            raw: raw as Prisma.InputJsonValue,
            tenantId: opts?.tenantId || null,
          },
          update: {
            pageName: page.name,
            platform: page.platform,
            fullName: conv.customerName || undefined,
            phones: phones.length ? phones : undefined,
            address: address || undefined,
            conversationId: conv.id,
            lastMessage: conv.lastMessage,
            conversationType: (raw.type as string) || undefined,
            dataAt: parseOptionalDate(conv.updatedAt) ?? undefined,
            source: 'sync_conversations',
            raw: raw as Prisma.InputJsonValue,
          },
        });
        upserted += 1;
        fetched += 1;
      }
    }

    const truncated = total != null && fetched < total && !usedConversationsFallback;

    // Bổ sung conversationId / lastMessage / type từ conversations (1 trang, không nặng)
    if (!usedConversationsFallback) try {
      this.logger.log(`Pancake sync page=${pageId} enriching from conversations…`);
      const { result: convs } = await this.withPageTokenRetry(
        pageId,
        opts?.tenantId,
        (pageToken) => this.client.listConversations(pageId, pageToken, { limit: 100 }),
      );
      for (const conv of convs.conversations) {
        const raw = conv.raw || {};
        const custId =
          String(
            (raw.customers as { id?: string }[] | undefined)?.[0]?.id ||
              (raw.page_customer as { id?: string } | undefined)?.id ||
              conv.customerId ||
              '',
          ) || null;
        if (!custId) continue;
        const phones = [
          ...new Set([
            ...collectPhonesFromPancakeRaw(raw),
            ...extractPhonesFromText(conv.lastMessage),
          ]),
        ];
        const addressFromConv =
          collectAddressFromPancakeRaw(raw) ||
          collectAddressFromPancakeRaw(
            (raw.page_customer as Record<string, unknown> | undefined) ?? undefined,
          ) ||
          extractAddressFromText(conv.lastMessage);
        const existing = await this.prisma.pancakeLead.findUnique({
          where: {
            pageId_pancakeCustomerId: { pageId, pancakeCustomerId: custId },
          },
        });
        if (!existing) continue;
        const mergedPhones = [...new Set([...existing.phones, ...phones])];
        await this.prisma.pancakeLead.update({
          where: { id: existing.id },
          data: {
            conversationId: conv.id,
            lastMessage: conv.lastMessage,
            conversationType: (raw.type as string) || existing.conversationType,
            phones: mergedPhones,
            ...(addressFromConv && !existing.address ? { address: addressFromConv } : {}),
            fullName: existing.fullName || conv.customerName,
            dataAt: parseOptionalDate(conv.updatedAt) ?? existing.dataAt,
          },
        });

        // Nhận diện chốt đơn từ tin gần nhất (và tải thêm tin nếu có dấu hiệu)
        let orderTexts: Array<string | null | undefined> = [conv.lastMessage];
        let chatPhones = mergedPhones;
        const hint = /มัดจำ|สั่งซื้อ|โอนเงิน|ยอดรวม|deposit|đặt\s*cọc|đơn\s*hàng|chuyển\s*khoản|ご注文|入金/i.test(
          conv.lastMessage || '',
        );
        if (hint && existing.stage !== 'customer') {
          try {
            const { result: msgs } = await this.withPageTokenRetry(
              pageId,
              opts?.tenantId,
              (pageToken) => this.client.listMessages(pageId, conv.id, pageToken, { limit: 40 }),
            );
            orderTexts = [conv.lastMessage, ...msgs.messages.map((m) => m.message)];
            chatPhones = [
              ...new Set([...mergedPhones, ...extractPhonesFromMessages(msgs.messages)]),
            ];
            await sleep(350);
          } catch (e) {
            this.logger.warn(
              `chat-order scan messages failed conv=${conv.id}: ${(e as Error).message}`,
            );
          }
        }
        const signal = detectOrderClosedFromTexts(orderTexts);
        if (signal.closed) {
          await this.upgradeLeadFromChatOrder({
            pageId,
            conversationId: conv.id,
            customerId: custId,
            fullName: conv.customerName || existing.fullName,
            phones: chatPhones,
            address: addressFromConv || existing.address,
            lastMessage: conv.lastMessage,
            signal,
            tenantId: opts?.tenantId,
          });
        }
      }

      // Khách có SĐT nhưng chưa có địa chỉ: đọc thêm tin nhắn (giới hạn) để trích 住所/địa chỉ
      const needAddr = await this.prisma.pancakeLead.findMany({
        where: {
          pageId,
          NOT: { phones: { equals: [] } },
          OR: [{ address: null }, { address: '' }],
          conversationId: { not: null },
        },
        take: 15,
        orderBy: { updatedAt: 'desc' },
      });
      let addrFilled = 0;
      for (const lead of needAddr) {
        if (!lead.conversationId) continue;
        try {
          const { result: msgs } = await this.withPageTokenRetry(
            pageId,
            opts?.tenantId,
            (pageToken) =>
              this.client.listMessages(pageId, lead.conversationId!, pageToken, { limit: 40 }),
          );
          const fromChat =
            msgs.messages
              .map((m) => extractAddressFromText(m.message))
              .find((a): a is string => Boolean(a)) ?? null;
          if (!fromChat) {
            await sleep(400);
            continue;
          }
          await this.prisma.pancakeLead.update({
            where: { id: lead.id },
            data: { address: fromChat },
          });
          addrFilled += 1;
          await sleep(400);
        } catch (e) {
          this.logger.warn(
            `address enrich from chat failed lead=${lead.id}: ${(e as Error).message}`,
          );
        }
      }
      if (addrFilled) {
        this.logger.log(
          `Pancake sync page=${pageId} filled address from chat for ${addrFilled} leads`,
        );
      }
    } catch (e) {
      this.logger.warn(`sync conversations enrich failed: ${(e as Error).message}`);
    }

    // Quét chat → tự gán nhãn follow / Đã chốt (ưu tiên lead có SĐT+địa chỉ)
    const autoLabel = await this.scanAndAutoLabelPageLeads(pageId, {
      tenantId: opts?.tenantId,
      maxScan: 40,
    });

    const stored = await this.prisma.pancakeLead.count({ where: { pageId } });
    const withPhone = await this.prisma.pancakeLead.count({
      where: { pageId, NOT: { phones: { equals: [] } } },
    });
    const withAddress = await this.prisma.pancakeLead.count({
      where: {
        pageId,
        AND: [{ address: { not: null } }, { NOT: { address: '' } }],
      },
    });
    const closedCount = await this.prisma.pancakeLead.count({
      where: { pageId, stage: 'customer' },
    });

    this.logger.log(
      `Pancake sync DONE pageId=${pageId} fetched=${fetched} upserted=${upserted} stored=${stored} withPhone=${withPhone} withAddress=${withAddress} truncated=${truncated} autoLabelClosed=${autoLabel.closed} autoLabelScanned=${autoLabel.scanned}`,
    );

    const warnings: string[] = [];
    if (pageTokenRegenerated) {
      warnings.push(
        'Đã tạo page_access_token mới — token cũ trên Pancake (nếu có) đã bị vô hiệu.',
      );
    }
    if (truncated) {
      warnings.push(
        `Chỉ đồng bộ ${fetched}/${total} khách (giới hạn ${maxPages} trang). Bấm Đồng bộ thêm lần nữa hoặc tăng maxPages.`,
      );
    }
    if (usedConversationsFallback) {
      warnings.push(
        'API page_customers của Pancake lỗi tạm — đã đồng bộ từ hội thoại gần nhất thay thế.',
      );
    }

    return {
      pageId,
      pageName: page.name,
      fetched,
      upserted,
      totalFromPancake: total,
      storedInDb: stored,
      withPhoneCount: withPhone,
      withAddressCount: withAddress,
      closedCount,
      autoLabel,
      truncated,
      pageTokenRegenerated,
      warning: warnings.length ? warnings.join(' ') : null,
      note: usedConversationsFallback
        ? `Đã đồng bộ ${upserted} lead từ hội thoại (fallback). Quét chat: ${autoLabel.closed} Đã chốt / ${autoLabel.follow} follow (quét ${autoLabel.scanned}).`
        : `Đã đồng bộ ${upserted} khách (Pancake tổng ${total ?? '?'}). Quét chat tự gán nhãn: ${autoLabel.closed} Đã chốt · ${autoLabel.follow} follow (quét ${autoLabel.scanned}/${autoLabel.candidates}). Có SĐT: ${withPhone} · địa chỉ: ${withAddress}.`,
    };
  }

  /**
   * Quét tin nhắn hội thoại → gán nhãn:
   * - Có tín hiệu chuyển khoản / xác nhận đơn → Đã chốt (+ stage customer)
   * - Chưa → follow
   * Ưu tiên lead đã có SĐT + địa chỉ.
   */
  async scanAndAutoLabelPageLeads(
    pageId: string,
    opts?: { tenantId?: string | null; maxScan?: number },
  ) {
    const maxScan = Math.min(Math.max(opts?.maxScan ?? 40, 1), 80);
    this.logger.log(`Pancake auto-label START pageId=${pageId} maxScan=${maxScan}`);

    const pool = await this.prisma.pancakeLead.findMany({
      where: {
        pageId,
        conversationId: { not: null },
        NOT: { stage: 'customer' },
      },
      orderBy: { updatedAt: 'desc' },
      take: 300,
    });

    // Bỏ qua đã chốt chắc chắn
    const candidates = pool
      .filter((l) => l.stage !== 'customer' && !l.labels.includes('Đã chốt'))
      .map((l) => {
        const hasPhone = l.phones.length > 0;
        const hasAddr = Boolean(l.address?.trim());
        let score = 0;
        if (hasPhone && hasAddr) score += 100;
        else if (hasPhone) score += 50;
        else if (hasAddr) score += 30;
        if (
          /มัดจำ|สั่งซื้อ|โอนเงิน|ยอดรวม|deposit|đặt\s*cọc|đơn\s*hàng|chuyển\s*khoản|ご注文|入金|โอนสำเร็จ/i.test(
            l.lastMessage || '',
          )
        ) {
          score += 60;
        }
        return { lead: l, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxScan);

    let scanned = 0;
    let closed = 0;
    let follow = 0;
    let errors = 0;

    for (const { lead } of candidates) {
      if (!lead.conversationId) continue;
      scanned += 1;
      try {
        const { result: msgs } = await this.withPageTokenRetry(
          pageId,
          opts?.tenantId,
          (pageToken) =>
            this.client.listMessages(pageId, lead.conversationId!, pageToken, { limit: 50 }),
        );
        const texts = [lead.lastMessage, ...msgs.messages.map((m) => m.message)];
        const phones = [
          ...new Set([...lead.phones, ...extractPhonesFromMessages(msgs.messages)]),
        ];
        const addressFromChat =
          msgs.messages
            .map((m) => extractAddressFromText(m.message))
            .find((a): a is string => Boolean(a)) || null;
        const address = lead.address || addressFromChat;
        const signal = detectOrderClosedFromTexts(texts);

        // Có SĐT+ĐC từ chat nhưng chưa đủ tín hiệu đơn → vẫn follow (đủ liên hệ để follow)
        if (signal.closed) {
          const up = await this.upgradeLeadFromChatOrder({
            pageId,
            conversationId: lead.conversationId,
            customerId: lead.pancakeCustomerId,
            fullName: lead.fullName,
            phones,
            address,
            lastMessage: lead.lastMessage,
            signal,
            tenantId: opts?.tenantId,
          });
          if (up.upgraded || up.stage === 'customer') closed += 1;
          else follow += 1;
        } else {
          const labels = ensureDefaultLabels('conversation', lead.labels);
          await this.prisma.pancakeLead.update({
            where: { id: lead.id },
            data: {
              phones: phones.length ? phones : undefined,
              address: address || undefined,
              labels,
              // giữ stage conversation
            },
          });
          follow += 1;
        }
        await sleep(400);
      } catch (e) {
        errors += 1;
        this.logger.warn(
          `auto-label scan failed lead=${lead.id}: ${(e as Error).message}`,
        );
        await sleep(600);
      }
    }

    this.logger.log(
      `Pancake auto-label DONE pageId=${pageId} scanned=${scanned} closed=${closed} follow=${follow} errors=${errors}`,
    );

    return {
      candidates: candidates.length,
      scanned,
      closed,
      follow,
      errors,
    };
  }

  /**
   * Webhook Pancake → upsert lead + trích SĐT từ tin nhắn.
   * Payload thực tế có thể khác — parse linh hoạt.
   */
  async handleWebhook(payload: unknown) {
    const body = (payload ?? {}) as Record<string, unknown>;
    const pageId = String(
      body.page_id || body.pageId || (body.page as Record<string, unknown> | undefined)?.id || '',
    ).trim();
    const conversationId = String(
      body.conversation_id ||
        body.conversationId ||
        (body.conversation as Record<string, unknown> | undefined)?.id ||
        '',
    ).trim();

    const customer =
      (body.customer as Record<string, unknown> | undefined) ||
      (body.page_customer as Record<string, unknown> | undefined) ||
      ((body.customers as Record<string, unknown>[] | undefined)?.[0] ?? undefined) ||
      {};

    const message =
      (body.message as Record<string, unknown> | undefined) ||
      (body.content as Record<string, unknown> | undefined) ||
      {};

    const from =
      (message.from as Record<string, unknown> | undefined) ||
      (body.from as Record<string, unknown> | undefined) ||
      {};

    const fromId = from.id != null ? String(from.id) : null;
    if (pageId && fromId && fromId === pageId) {
      return { ok: true, skipped: 'page_sender' };
    }
    if (body.is_page_sender === true || body.from_page === true) {
      return { ok: true, skipped: 'page_sender' };
    }

    const text = String(
      message.text ||
        message.original_message ||
        message.message ||
        body.text ||
        body.snippet ||
        '',
    );
    const phones = [
      ...new Set([
        ...collectPhonesFromPancakeRaw(customer),
        ...collectPhonesFromPancakeRaw(message),
        ...collectPhonesFromPancakeRaw(body),
        ...extractPhonesFromText(text),
      ]),
    ];
    const address =
      collectAddressFromPancakeRaw(customer) ||
      collectAddressFromPancakeRaw(message) ||
      collectAddressFromPancakeRaw(body) ||
      extractAddressFromText(text);

    const pancakeCustomerId = String(
      customer.id ||
        customer.page_customer_id ||
        body.customer_id ||
        fromId ||
        conversationId ||
        '',
    ).trim();

    if (!pageId || !pancakeCustomerId) {
      this.logger.warn(
        `pancake webhook missing ids keys=${Object.keys(body).join(',')}`,
      );
      return { ok: true, skipped: 'missing_ids', keys: Object.keys(body) };
    }

    const pageCfg = await this.prisma.pancakePageConfig.findUnique({
      where: { pageId },
    });
    const fullName =
      (customer.name as string) ||
      (from.name as string) ||
      (body.customer_name as string) ||
      null;

    const existing = await this.prisma.pancakeLead.findUnique({
      where: {
        pageId_pancakeCustomerId: { pageId, pancakeCustomerId },
      },
    });

    const mergedPhones = [...new Set([...(existing?.phones ?? []), ...phones])];
    const dataAtRaw =
      message.created_time ||
      message.inserted_at ||
      body.updated_at ||
      body.created_time;
    const dataAt = dataAtRaw ? new Date(String(dataAtRaw)) : new Date();

    await this.prisma.pancakeLead.upsert({
      where: {
        pageId_pancakeCustomerId: { pageId, pancakeCustomerId },
      },
      create: {
        pageId,
        pageName: pageCfg?.pageName ?? null,
        platform: pageCfg?.platform ?? null,
        pancakeCustomerId,
        customerId:
          customer.customer_id != null ? String(customer.customer_id) : null,
        psid: customer.psid != null ? String(customer.psid) : fromId,
        fullName,
        phones: mergedPhones,
        emails: [],
        address,
        notes: typeof customer.notes === 'string' ? customer.notes : null,
        conversationId: conversationId || null,
        lastMessage: text || null,
        conversationType: (body.type as string) || null,
        dataAt: Number.isNaN(dataAt.getTime()) ? new Date() : dataAt,
        source: 'webhook',
        labels: ['follow'],
        raw: body as Prisma.InputJsonValue,
        tenantId: pageCfg?.tenantId ?? null,
      },
      update: {
        fullName: fullName || undefined,
        phones: mergedPhones,
        address: address || undefined,
        conversationId: conversationId || undefined,
        lastMessage: text || undefined,
        conversationType: (body.type as string) || undefined,
        dataAt: Number.isNaN(dataAt.getTime()) ? undefined : dataAt,
        source: 'webhook',
        raw: body as Prisma.InputJsonValue,
        pageName: pageCfg?.pageName ?? undefined,
        platform: pageCfg?.platform ?? undefined,
      },
    });

    return {
      ok: true,
      pageId,
      pancakeCustomerId,
      conversationId: conversationId || null,
      phones: mergedPhones,
    };
  }

  async disconnect(tenantId?: string | null) {
    const session = await this.getSession(tenantId);
    if (!session) return { disconnected: true };
    await this.prisma.pancakeOAuthSession.delete({ where: { id: session.id } });
    return { disconnected: true };
  }

  /**
   * Nâng lead → customer + nhãn Đã chốt khi chat có tín hiệu chốt đơn
   * (xác nhận đơn / cọc / chuyển khoản thành công).
   */
  private async upgradeLeadFromChatOrder(input: {
    pageId: string;
    conversationId: string;
    customerId?: string | null;
    fullName?: string | null;
    phones: string[];
    address?: string | null;
    lastMessage?: string | null;
    signal: ReturnType<typeof detectOrderClosedFromTexts>;
    tenantId?: string | null;
  }): Promise<{ upgraded: boolean; stage: string; labels: string[] }> {
    const custId =
      String(input.customerId || '').trim() ||
      null;

    let lead =
      (await this.prisma.pancakeLead.findFirst({
        where: {
          pageId: input.pageId,
          conversationId: input.conversationId,
        },
      })) ||
      (custId
        ? await this.prisma.pancakeLead.findUnique({
            where: {
              pageId_pancakeCustomerId: {
                pageId: input.pageId,
                pancakeCustomerId: custId,
              },
            },
          })
        : null);

    if (!lead && custId) {
      // chưa có lead — tạo mới nếu đã chốt
      if (!input.signal.closed) {
        return { upgraded: false, stage: 'conversation', labels: ['follow'] };
      }
      lead = await this.prisma.pancakeLead.create({
        data: {
          pageId: input.pageId,
          pancakeCustomerId: custId,
          customerId: custId,
          fullName: input.fullName,
          phones: input.phones,
          address: input.address || null,
          conversationId: input.conversationId,
          lastMessage: input.lastMessage,
          stage: 'customer',
          labels: ensureDefaultLabels('customer', []),
          orderedAt: new Date(),
          orderRef: `chat-${input.conversationId.slice(0, 12)}`,
          source: 'chat_order_detect',
          tenantId: input.tenantId || null,
        },
      });
      this.logger.log(
        `chat-order create customer lead=${lead.id} page=${input.pageId} conf=${input.signal.confidence}`,
      );
      return { upgraded: true, stage: lead.stage, labels: lead.labels };
    }

    if (!lead) {
      return { upgraded: false, stage: 'conversation', labels: ['follow'] };
    }

    if (!input.signal.closed) {
      return {
        upgraded: false,
        stage: lead.stage,
        labels: ensureDefaultLabels(lead.stage, lead.labels),
      };
    }

    if (lead.stage === 'customer' && lead.labels.includes('Đã chốt')) {
      const phones = [...new Set([...lead.phones, ...input.phones])];
      if (phones.length !== lead.phones.length || (input.address && !lead.address)) {
        const updated = await this.prisma.pancakeLead.update({
          where: { id: lead.id },
          data: {
            phones,
            address: input.address || lead.address,
            fullName: input.fullName || lead.fullName,
          },
        });
        return { upgraded: false, stage: updated.stage, labels: updated.labels };
      }
      return { upgraded: false, stage: lead.stage, labels: lead.labels };
    }

    const phones = [...new Set([...lead.phones, ...input.phones])];
    const updated = await this.prisma.pancakeLead.update({
      where: { id: lead.id },
      data: {
        stage: 'customer',
        labels: ensureDefaultLabels('customer', lead.labels),
        phones,
        address: input.address || lead.address,
        fullName: input.fullName || lead.fullName,
        lastMessage: input.lastMessage || lead.lastMessage,
        conversationId: input.conversationId,
        orderedAt: lead.orderedAt ?? new Date(),
        orderRef: lead.orderRef || `chat-${input.conversationId.slice(0, 12)}`,
        source: 'chat_order_detect',
      },
    });
    this.logger.log(
      `chat-order upgrade lead=${updated.id} conf=${input.signal.confidence} reasons=${input.signal.reasons.join(',')}`,
    );
    return { upgraded: true, stage: updated.stage, labels: updated.labels };
  }

  /**
   * Khi có đơn (Sapo inbox / đánh dấu tay): gắn SĐT + địa chỉ và nâng stage → customer.
   * Match theo psid / conversationId Pancake / SĐT đã chuẩn hoá.
   */
  async upgradeLeadFromOrder(input: {
    phone?: string | null;
    address?: string | null;
    customerName?: string | null;
    psid?: string | null;
    conversationId?: string | null;
    orderRef?: string | null;
    pageId?: string | null;
  }) {
    const phone = input.phone?.trim() || null;
    const address = input.address?.trim() || null;
    const psid = input.psid?.trim() || null;
    const conversationId = input.conversationId?.trim() || null;
    const phoneDigits = phone ? phone.replace(/\D/g, '') : '';

    const or: Prisma.PancakeLeadWhereInput[] = [];
    if (psid) or.push({ psid });
    if (conversationId) or.push({ conversationId });
    if (phoneDigits.length >= 9) {
      or.push({ phones: { has: phone } });
      // partial: Prisma has không hỗ trợ contains trên array element — lấy ứng viên rồi lọc
    }
    if (!or.length && !phoneDigits) {
      return { upgraded: 0, reason: 'no_match_keys' as const };
    }

    let candidates = or.length
      ? await this.prisma.pancakeLead.findMany({
          where: {
            OR: or,
            ...(input.pageId ? { pageId: input.pageId } : {}),
          },
          take: 20,
        })
      : [];

    if (!candidates.length && phoneDigits.length >= 9) {
      const pool = await this.prisma.pancakeLead.findMany({
        where: {
          ...(input.pageId ? { pageId: input.pageId } : {}),
          NOT: { phones: { equals: [] } },
        },
        take: 500,
        orderBy: { updatedAt: 'desc' },
      });
      candidates = pool.filter((l) =>
        l.phones.some((p) => {
          const d = p.replace(/\D/g, '');
          return d === phoneDigits || d.endsWith(phoneDigits) || phoneDigits.endsWith(d);
        }),
      );
    }

    if (!candidates.length) {
      return { upgraded: 0, reason: 'not_found' as const };
    }

    let upgraded = 0;
    for (const lead of candidates) {
      const mergedPhones = [
        ...new Set([
          ...lead.phones,
          ...(phone ? [phone] : []),
        ]),
      ];
      await this.prisma.pancakeLead.update({
        where: { id: lead.id },
        data: {
          stage: 'customer',
          phones: mergedPhones,
          address: address || lead.address,
          fullName: input.customerName?.trim() || lead.fullName,
          orderedAt: new Date(),
          orderRef: input.orderRef || lead.orderRef,
          labels: ensureDefaultLabels('customer', lead.labels),
        },
      });
      upgraded += 1;
    }

    this.logger.log(
      `upgradeLeadFromOrder orderRef=${input.orderRef ?? '?'} upgraded=${upgraded}`,
    );
    return { upgraded, reason: 'ok' as const };
  }

  async updateLeadCrm(
    leadId: string,
    body: {
      labels?: string[];
      follow?: boolean;
      stage?: 'conversation' | 'customer';
      phone?: string;
      address?: string;
      notes?: string;
      orderRef?: string;
    },
  ) {
    const lead = await this.prisma.pancakeLead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Không tìm thấy lead');

    const data: Prisma.PancakeLeadUpdateInput = {};
    if (body.labels) data.labels = body.labels;
    if (body.follow === true) data.followAt = new Date();
    if (body.follow === false) data.followAt = null;
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.phone?.trim()) {
      data.phones = [...new Set([...lead.phones, body.phone.trim()])];
    }
    if (body.address?.trim()) data.address = body.address.trim();

    if (body.stage === 'customer' || body.orderRef || (body.phone && body.address)) {
      data.stage = 'customer';
      data.orderedAt = lead.orderedAt ?? new Date();
      if (body.orderRef) data.orderRef = body.orderRef;
      data.labels = ensureDefaultLabels('customer', (body.labels ?? lead.labels) as string[]);
    } else if (body.stage === 'conversation') {
      data.stage = 'conversation';
      data.labels = ensureDefaultLabels('conversation', (body.labels ?? lead.labels) as string[]);
    } else if (!body.labels && (!lead.labels || lead.labels.length === 0)) {
      data.labels = ensureDefaultLabels(lead.stage, lead.labels);
    }

    const updated = await this.prisma.pancakeLead.update({
      where: { id: leadId },
      data,
    });
    return {
      id: updated.id,
      stage: updated.stage,
      labels: updated.labels,
      followAt: updated.followAt?.toISOString() ?? null,
      phones: updated.phones,
      address: updated.address,
      orderRef: updated.orderRef,
      orderedAt: updated.orderedAt?.toISOString() ?? null,
    };
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Nhãn mặc định: đã chốt (customer) hoặc follow (chưa chốt). */
function ensureDefaultLabels(stage: string | null | undefined, labels: string[] | null | undefined): string[] {
  const set = new Set((labels ?? []).filter(Boolean));
  if (set.has('Follow') || set.has('follow-up')) {
    set.delete('Follow');
    set.delete('follow-up');
    set.add('follow');
  }
  const isCustomer = stage === 'customer' || set.has('Đã chốt');
  if (isCustomer) {
    set.add('Đã chốt');
    set.delete('follow');
  } else {
    set.add('follow');
  }
  return [...set];
}

function labelsNeedPersist(before: string[], after: string[]): boolean {
  if (before.length !== after.length) return true;
  const b = new Set(before);
  return after.some((x) => !b.has(x));
}

/** Tránh Invalid Date làm Prisma crash khi upsert. */
function parseOptionalDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
