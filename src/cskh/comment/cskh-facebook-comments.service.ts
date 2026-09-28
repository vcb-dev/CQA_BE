import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { FacebookCskhConfig } from '@prisma/client';
import axios from 'axios';
import { isPrismaBusyError } from '../../common/prisma-busy.util';
import { PrismaService } from '../../prisma/prisma.service';
import { FacebookGraphService } from '../facebook/facebook-graph.service';
import { commentMediaFromGraph } from '../facebook/facebook-message.util';
import {
  GRAPH_BASE,
  PAGE_WEBHOOK_SUBSCRIBED_FIELDS,
  cskhInboxGraphPlatform,
} from '../facebook/facebook-oauth.util';
import { CskhInboxRealtimeService } from '../inbox/cskh-inbox-realtime.service';

/**
 * ClipDb là hàm để cắt chuỗi string và trả về chuỗi con có độ dài không vượt quá maxLen.
 */
function clipDb(
  value: string | null | undefined,
  maxLen: number,
): string | null {
  if (value == null) return null;
  const s = String(value);
  if (!s) return null;
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

/**
 * commentThreadPsid là hàm để tạo ID cho thread của bình luận.
 */
export function commentThreadPsid(postId: string, fromId: string): string {
  return `c:${postId}:${fromId}`;
}

/** Graph Comment type. Tương đương với FbComment trong Graph API. */
type GraphComment = {
  id: string;
  message?: string;
  created_time?: string;
  from?: { id?: string; name?: string };
  parent?: { id?: string };
  attachment?: {
    type?: string;
    url?: string;
    target?: { url?: string };
    media?: { image?: { src?: string }; source?: string };
  };
};

/** Page `feed` webhook — chỉ lấy comment add/edit. */
export interface FbFeedCommentValue {
  item?: string;
  verb?: string;
  comment_id?: string;
  post_id?: string;
  parent_id?: string;
  message?: string;
  created_time?: number | string;
  from?: { id?: string; name?: string };
  post?: { id?: string };
}

export interface ParsedFbFeedComment {
  commentId: string;
  postId: string;
  parentId: string | null;
  text: string;
  fromId: string;
  fromName: string | null;
  commentedAt: Date;
}

/**
 * Hàm parsePageFeedComment là hàm để phân tích dữ liệu từ webhook của Facebook và trả về dữ liệu đã được phân tích.
 * value là dữ liệu từ webhook của Facebook.
 * return là dữ liệu đã được phân tích.
 */
export function parsePageFeedComment(
  value: FbFeedCommentValue | null | undefined,
): ParsedFbFeedComment | null {
  if (!value || value.item !== 'comment') return null;
  const verb = String(value.verb || 'add').toLowerCase();
  if (verb !== 'add' && verb !== 'edited') return null;
  const commentId = String(value.comment_id || '').trim();
  const postId = String(value.post_id || value.post?.id || '').trim();
  if (!commentId || !postId) return null;

  const rawParent = String(value.parent_id || '').trim();
  const parentId = rawParent && rawParent !== postId ? rawParent : null;
  const fromId = String(value.from?.id || '').trim();
  const created = value.created_time;
  const commentedAt =
    typeof created === 'number'
      ? new Date(created * (created < 1e12 ? 1000 : 1))
      : created
        ? new Date(Number(created) || created)
        : new Date();
  return {
    commentId,
    postId,
    parentId,
    text: String(value.message ?? '').trim() || '(empty)',
    fromId,
    fromName: value.from?.name ? String(value.from.name) : null,
    commentedAt: Number.isNaN(commentedAt.getTime()) ? new Date() : commentedAt,
  };
}

@Injectable()
export class CskhFacebookCommentsService {
  private readonly logger = new Logger(CskhFacebookCommentsService.name);
  /**
   * feedSubscribeAttempted là một Set để lưu trữ các pageId mà đã thử đăng ký webhook feed.
   */
  private readonly feedSubscribeAttempted = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: FacebookGraphService,
    private readonly realtime: CskhInboxRealtimeService,
  ) {}
  /**
   * effectiveTenantId là hàm để xác định tenantId hiệu quả.
   * Nếu config.tenantId không tồn tại thì sẽ trả về requestTenantId,
   * nếu requestTenantId cũng không tồn tại thì trả về null.
   */
  private effectiveTenantId(
    config: FacebookCskhConfig,
    requestTenantId?: string,
  ): string | null {
    return config.tenantId ?? requestTenantId ?? null;
  }
  /**
   * rethrowGraphOrBusy là hàm để ném lại lỗi từ Graph API hoặc lỗi Prisma.
   */
  private rethrowGraphOrBusy(e: unknown): never {
    if (isPrismaBusyError(e)) {
      throw new ServiceUnavailableException(
        'Hệ thống đang bận. Thử lại sau vài giây.',
      );
    }
    const msg = (e as Error)?.message || String(e);
    if (/\(#10\)|does not have permission/i.test(msg)) {
      throw new BadRequestException(
        'Meta chưa cấp quyền bình luận Page (pages_manage_engagement). Bật quyền rồi Kết nối lại Facebook.',
      );
    }
    if (/Graph API|OAuth|permission|access token|code=\(#?\d+\)/i.test(msg)) {
      throw new BadRequestException(
        `${msg} — thử Kết nối lại Facebook trong Cài đặt.`,
      );
    }
    throw e;
  }

  /**
   * getFbPageConfig là hàm để lấy config của page Facebook.
   */
  private async getFbPageConfig(
    pageId: string,
    tenantId?: string,
  ): Promise<FacebookCskhConfig> {
    const config = await this.prisma.facebookCskhConfig.findUnique({
      where: { pageId },
    });
    if (!config || !config.enabled) {
      throw new NotFoundException('Không tìm thấy kênh hoặc kênh đang tắt.');
    }
    if (cskhInboxGraphPlatform(config.metadata) !== 'messenger') {
      throw new BadRequestException('pageId không phải fanpage Facebook.');
    }
    if (tenantId && config.tenantId && config.tenantId !== tenantId) {
      throw new ForbiddenException('Kênh không thuộc tenant.');
    }
    if (!config.pageAccessToken) {
      throw new BadRequestException(
        'Thiếu page access token — kết nối lại Facebook.',
      );
    }
    return config;
  }
  /**
   * processWebhookPayload là hàm để xử lý payload từ webhook của Facebook.
   * payload là payload từ webhook của Facebook.
   * return là void.
   */
  async processWebhookPayload(payload: unknown): Promise<void> {
    const body = payload as {
      object?: string;
      entry?: Array<{
        id?: string;
        changes?: Array<{ field?: string; value?: FbFeedCommentValue }>;
      }>;
    };
    if (body.object !== 'page' || !Array.isArray(body.entry)) return;

    for (const entry of body.entry) {
      const pageId = String(entry.id || '').trim();
      if (!pageId) continue;
      for (const change of entry.changes ?? []) {
        if (change.field !== 'feed') continue;
        // Phân tích dữ liệu từ webhook của Facebook.
        const parsed = parsePageFeedComment(change.value);
        if (!parsed) continue;
        try {
          // Xử lý dữ liệu từ webhook của Facebook.
          await this.ingestWebhookComment(pageId, parsed);
        } catch (e) {
          this.logger.warn(
            `FB comment webhook ingest failed page=${pageId}: ${(e as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * ingestWebhookComment là hàm để xử lý dữ liệu từ webhook của Facebook.
   * pageId là id của page Facebook.
   * parsed là dữ liệu đã được phân tích.
   * return là void.
   */
  private async ingestWebhookComment(
    pageId: string,
    parsed: ParsedFbFeedComment,
  ): Promise<void> {
    const config = await this.prisma.facebookCskhConfig.findUnique({
      where: { pageId },
    });
    if (
      !config?.enabled ||
      !config.pageAccessToken ||
      cskhInboxGraphPlatform(config.metadata) !== 'messenger'
    ) {
      return;
    }
    void this.ensurePageFeedSubscribe(config);

    let fromId = parsed.fromId;
    let fromName = parsed.fromName;
    let parentId = parsed.parentId;
    const fetched = await this.graph.fetchPageCommentById(
      parsed.commentId,
      config.pageAccessToken,
    );
    if (fetched) {
      fromId = String(fetched.from?.id || fromId || '').trim();
      fromName = fetched.from?.name ?? fromName;
      if (!parentId && fetched.parent?.id) {
        const pid = String(fetched.parent.id);
        parentId = pid !== parsed.postId ? pid : null;
      }
    }
    const fbPostId = clipDb(parsed.postId, 64) ?? parsed.postId.slice(0, 64);
    const existingPost = await this.prisma.cskhFbPost.findUnique({
      where: { pageId_fbPostId: { pageId: config.pageId, fbPostId } },
      select: { permalink: true },
    });
    await this.prisma.cskhFbPost.upsert({
      where: { pageId_fbPostId: { pageId: config.pageId, fbPostId } },
      create: {
        pageId: config.pageId,
        fbPostId,
        lastCommentAt: parsed.commentedAt,
        tenantId: config.tenantId,
      },
      update: { lastCommentAt: parsed.commentedAt },
    });
    if (!existingPost?.permalink) {
      await this.enrichPostFromGraph(config, fbPostId);
    }

    const graphComment: GraphComment & { parentId: string | null } = {
      id: parsed.commentId,
      message:
        fetched?.message ?? (parsed.text === '(empty)' ? '' : parsed.text),
      created_time: parsed.commentedAt.toISOString(),
      from: fromId ? { id: fromId, name: fromName ?? undefined } : undefined,
      parent: parentId ? { id: parentId } : undefined,
      parentId,
      attachment: fetched?.attachment,
    };
    const threadAuthorId =
      (await this.resolveThreadAuthorIdAsync(config.pageId, graphComment)) ||
      parentId ||
      parsed.commentId;

    await this.persistComment(
      config,
      fbPostId,
      graphComment,
      new Map([[parsed.commentId, graphComment]]),
      config.tenantId ?? undefined,
      {
        incrementUnread: fromId !== config.pageId,
        publish: true,
        threadAuthorId,
      },
    );
  }

  /**
   * ensurePageFeedSubscribe là hàm để đảm bảo page đã đăng ký webhook feed.
   * config là config của page Facebook.
   * return là void.
   */
  private async ensurePageFeedSubscribe(
    config: FacebookCskhConfig,
  ): Promise<void> {
    if (this.feedSubscribeAttempted.has(config.pageId)) return;
    this.feedSubscribeAttempted.add(config.pageId);
    try {
      await axios.post(`${GRAPH_BASE}/${config.pageId}/subscribed_apps`, null, {
        params: {
          subscribed_fields: PAGE_WEBHOOK_SUBSCRIBED_FIELDS,
          access_token: config.pageAccessToken,
        },
        timeout: 10_000,
      });
    } catch (e) {
      this.logger.warn(
        `Page feed subscribe ${config.pageId}: ${(e as Error).message}`,
      );
    }
  }

  private async enrichPostFromGraph(
    config: FacebookCskhConfig,
    fbPostId: string,
  ): Promise<void> {
    try {
      const post = await this.graph.fetchPagePostById(
        fbPostId,
        config.pageAccessToken,
      );
      if (!post) return;
      await this.prisma.cskhFbPost.updateMany({
        where: { pageId: config.pageId, fbPostId },
        data: {
          message: post.message ?? undefined,
          permalink: post.permalink_url ?? undefined,
          thumbnailUrl: post.full_picture ?? undefined,
        },
      });
    } catch (e) {
      this.logger.warn(`FB post enrich ${fbPostId}: ${(e as Error).message}`);
    }
  }

  /**
   * syncPageComments là hàm để đồng bộ bình luận của page Facebook.
   */
  async syncPageComments(pageId: string, tenantId?: string) {
    const config = await this.getFbPageConfig(pageId, tenantId);
    void this.ensurePageFeedSubscribe(config);
    // Lấy danh sách bài viết của page Facebook.
    let posts: Awaited<ReturnType<FacebookGraphService['fetchPageFeed']>>;
    try {
      posts = await this.graph.fetchPageFeed(
        config.pageId,
        config.pageAccessToken,
        15,
      );
    } catch (e) {
      this.rethrowGraphOrBusy(e);
    }

    let threadCount = 0;
    for (const post of posts) {
      // Cắt chuỗi id bài viết.
      const fbPostId = clipDb(post.id, 64) ?? post.id.slice(0, 64);
      // Lưu bài viết vào database bằng upsert.
      await this.prisma.cskhFbPost.upsert({
        where: { pageId_fbPostId: { pageId: config.pageId, fbPostId } },
        create: {
          pageId: config.pageId,
          fbPostId,
          message: post.message ?? null,
          permalink: post.permalink_url ?? null,
          thumbnailUrl: post.full_picture ?? null,
          tenantId: this.effectiveTenantId(config, tenantId),
        },
        update: {
          message: post.message ?? undefined,
          permalink: post.permalink_url ?? undefined,
          thumbnailUrl: post.full_picture ?? undefined,
        },
      });

      // Lấy danh sách bình luận của bài viết.
      let raw: Awaited<
        ReturnType<FacebookGraphService['fetchPagePostComments']>
      >;
      try {
        // Lấy danh sách bình luận của bài viết.
        raw = await this.graph.fetchPagePostComments(
          fbPostId,
          config.pageAccessToken,
          50,
        );
      } catch (e) {
        this.logger.warn(`fetch comments ${fbPostId}: ${(e as Error).message}`);
        continue;
      }
      // Chuyển đổi danh sách bình luận thành dạng flat.
      const flat: Array<GraphComment & { parentId: string | null }> = [];
      // Duyệt qua danh sách bình luận.
      for (const c of raw) {
        // Thêm bình luận vào danh sách flat.
        flat.push({ ...c, parentId: c.parent?.id ?? null });
        for (const r of c.comments?.data ?? []) {
          flat.push({
            ...r,
            parentId: r.parent?.id ?? c.id,
          });
        }
      }

      // Tạo map để lưu bình luận theo id.
      const byId = new Map(flat.map((c) => [c.id, c]));
      for (const c of flat) {
        // Lưu bình luận vào database.
        const n = await this.persistComment(
          config,
          fbPostId,
          c,
          byId,
          tenantId,
        );
        // Tăng số lượng thread.
        if (n) threadCount += n;
      }
    }
    // Lấy danh sách bình luận đã lưu từ database.
    const fromStore = await this.backfillInboxFromStoredComments(
      config,
      tenantId,
    );
    return {
      ok: true,
      postCount: posts.length,
      threadTouches: Math.max(threadCount, fromStore),
    };
  }

  /**
   * backfillInboxFromStoredComments là hàm để đồng bộ bình luận từ database vào inbox.
   * config là config của page Facebook.
   * tenantId là tenantId của page Facebook.
   * return là số lượng bình luận đã đồng bộ.
   */
  private async backfillInboxFromStoredComments(
    config: FacebookCskhConfig,
    tenantId?: string,
  ): Promise<number> {
    // Lấy danh sách bình luận đã lưu từ database.
    const rows = await this.prisma.cskhFbComment.findMany({
      where: { pageId: config.pageId },
      orderBy: { commentedAt: 'asc' },
    });
    let n = 0;
    for (const row of rows) {
      const isPage =
        row.direction === 'outbound' || row.authorFbId === config.pageId;
      const threadAuthorId = isPage
        ? row.parentFbCommentId
        : row.authorFbId && row.authorFbId !== config.pageId
          ? row.authorFbId
          : row.fbCommentId;
      if (!threadAuthorId) continue;
      try {
        await this.upsertInboxThread({
          config,
          fbPostId: row.fbPostId,
          threadAuthorId,
          customerName: isPage
            ? undefined
            : row.authorName || 'Khách hàng Facebook',
          text: row.text,
          commentedAt: row.commentedAt,
          fbCommentId: row.fbCommentId,
          direction: row.direction,
          tenantId: this.effectiveTenantId(config, tenantId),
        });
        n += 1;
      } catch (e) {
        this.logger.warn(
          `FB comment thread backfill ${row.fbCommentId}: ${(e as Error).message}`,
        );
      }
    }
    // Trả về số lượng bình luận đã đồng bộ.
    return n;
  }

  /**
   * persistComment là hàm để lưu bình luận vào database.
   * config là config của page Facebook.
   * fbPostId là id của bài viết.
   * c là dữ liệu của bình luận.
   * byId là map để lưu bình luận theo id.
   * requestTenantId là tenantId của page Facebook.
   * opts là các options cho việc lưu bình luận.
   */
  private async persistComment(
    config: FacebookCskhConfig,
    fbPostId: string,
    c: GraphComment & { parentId: string | null },
    byId: Map<string, GraphComment & { parentId: string | null }>,
    requestTenantId?: string,
    opts?: {
      incrementUnread?: boolean;
      publish?: boolean;
      threadAuthorId?: string;
    },
  ): Promise<number> {
    const fromId = String(c.from?.id || '').trim();
    const fbCommentId = clipDb(c.id, 64) ?? c.id.slice(0, 64);
    const media = commentMediaFromGraph(c);
    const text = media.text;
    const commentedAt = c.created_time ? new Date(c.created_time) : new Date();
    const tenantId = this.effectiveTenantId(config, requestTenantId);
    const isPage = Boolean(fromId && fromId === config.pageId);
    const direction = isPage ? 'outbound' : 'inbound';
    const parentFbCommentId = clipDb(c.parentId, 64);

    // Lưu bình luận vào database bằng upsert.
    await this.prisma.cskhFbComment.upsert({
      where: { fbCommentId },
      create: {
        pageId: config.pageId,
        fbPostId,
        fbCommentId,
        parentFbCommentId,
        text,
        authorName:
          clipDb(c.from?.name, 255) ?? (isPage ? null : 'Khách hàng Facebook'),
        authorFbId: clipDb(fromId || fbCommentId, 64),
        direction,
        commentedAt,
        tenantId,
      },
      update: {
        text,
        authorName:
          clipDb(c.from?.name, 255) ?? (isPage ? null : 'Khách hàng Facebook'),
        authorFbId: clipDb(fromId || fbCommentId, 64),
        parentFbCommentId,
      },
    });

    const threadAuthorId =
      opts?.threadAuthorId ||
      this.resolveThreadAuthorId(
        config.pageId,
        { ...c, parentId: c.parentId },
        byId,
      ) ||
      (await this.resolveThreadAuthorIdFromDb(
        config.pageId,
        fromId,
        c.parentId,
      )) ||
      (isPage ? c.parentId : fbCommentId);
    if (!threadAuthorId) return 0;

    try {
      await this.upsertInboxThread({
        config,
        fbPostId,
        threadAuthorId,
        customerName: isPage
          ? undefined
          : c.from?.name || 'Khách hàng Facebook',
        text,
        commentedAt,
        fbCommentId,
        direction,
        tenantId,
        messageType: media.messageType,
        attachmentUrl: media.attachmentUrl,
        incrementUnread: Boolean(opts?.incrementUnread) && !isPage,
        publish: Boolean(opts?.publish),
      });
    } catch (e) {
      this.logger.warn(
        `FB comment inbox ${fbCommentId}: ${(e as Error).message}`,
      );
      return 0;
    }
    return 1;
  }

  private async resolveThreadAuthorIdAsync(
    pageId: string,
    c: GraphComment & { parentId: string | null },
  ): Promise<string | null> {
    const fromId = String(c.from?.id || '').trim();
    if (fromId && fromId !== pageId) return fromId;
    return this.resolveThreadAuthorIdFromDb(pageId, fromId, c.parentId);
  }

  private async resolveThreadAuthorIdFromDb(
    pageId: string,
    fromId: string,
    parentId: string | null,
  ): Promise<string | null> {
    if (fromId && fromId !== pageId) return fromId;
    if (!parentId) return null;
    const parent = await this.prisma.cskhFbComment.findUnique({
      where: { fbCommentId: parentId },
      select: { authorFbId: true, direction: true, fbCommentId: true },
    });
    const author = String(parent?.authorFbId || '').trim();
    if (author && author !== pageId) return author;
    if (parent?.direction === 'inbound') {
      return author || parent.fbCommentId;
    }
    return parentId;
  }

  /** 1 người × 1 bài. Graph hay ẩn `from` — thread key = user id, hoặc comment/parent id. */
  private resolveThreadAuthorId(
    pageId: string,
    c: GraphComment & { parentId: string | null },
    byId: Map<string, GraphComment & { parentId: string | null }>,
  ): string | null {
    const fromId = String(c.from?.id || '').trim();
    if (fromId && fromId !== pageId) return fromId;
    let parentId = c.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const p = byId.get(parentId);
      if (!p) return parentId;
      const pid = String(p.from?.id || '').trim();
      if (pid && pid !== pageId) return pid;
      if (!pid) return p.id;
      parentId = p.parentId;
    }
    if (!fromId) return String(c.id || '').trim() || null;
    return null;
  }

  /**
   * upsertInboxThread là hàm để lưu thread của khách gốc vào database.
   * input là dữ liệu để lưu thread của khách gốc vào database.
   * return là void.
   */
  private async upsertInboxThread(input: {
    config: FacebookCskhConfig;
    fbPostId: string;
    threadAuthorId: string;
    customerName?: string;
    text: string;
    commentedAt: Date;
    fbCommentId: string;
    direction: string;
    tenantId: string | null;
    messageType?: string;
    attachmentUrl?: string | null;
    incrementUnread?: boolean;
    publish?: boolean;
  }): Promise<void> {
    // Tạo id cho thread.
    const participantPsid = commentThreadPsid(
      input.fbPostId,
      input.threadAuthorId,
    );
    // Lấy bài viết tương ứng.
    const post = await this.prisma.cskhFbPost.findUnique({
      where: {
        pageId_fbPostId: {
          pageId: input.config.pageId,
          fbPostId: input.fbPostId,
        },
      },
    });

    // Kiểm tra xem thread đã tồn tại chưa.
    const existingMsg = await this.prisma.cskhInboxMessage.findUnique({
      where: { fbMessageId: input.fbCommentId },
      select: { id: true },
    });
    const existing = await this.prisma.cskhInboxConversation.findUnique({
      where: {
        pageId_participantPsid: {
          pageId: input.config.pageId,
          participantPsid,
        },
      },
    });
    const bumpUnread =
      Boolean(input.incrementUnread) &&
      input.direction === 'inbound' &&
      !existingMsg;

    // Kiểm tra xem bình luận mới hơn bình luận cuối cùng trong thread không.
    const newer =
      !existing?.lastMessageAt ||
      input.commentedAt.getTime() >= existing.lastMessageAt.getTime();

    // Lưu thread vào database bằng upsert.
    const conv = await this.prisma.cskhInboxConversation.upsert({
      where: {
        pageId_participantPsid: {
          pageId: input.config.pageId,
          participantPsid,
        },
      },
      create: {
        pageId: input.config.pageId,
        pageName: input.config.pageName,
        participantPsid,
        customerName: input.customerName || 'Khách hàng Facebook',
        lastMessage: input.text,
        lastMessageAt: input.commentedAt,
        unreadCount: bumpUnread ? 1 : 0,
        kind: 'fb_comment',
        sourcePostId: input.fbPostId,
        sourcePermalink: post?.permalink ?? null,
        sourceThumb: post?.thumbnailUrl ?? null,
        tenantId: input.tenantId,
      },
      update: {
        kind: 'fb_comment',
        sourcePostId: input.fbPostId,
        ...(input.customerName ? { customerName: input.customerName } : {}),
        ...(post?.permalink ? { sourcePermalink: post.permalink } : {}),
        ...(post?.thumbnailUrl ? { sourceThumb: post.thumbnailUrl } : {}),
        ...(newer
          ? { lastMessage: input.text, lastMessageAt: input.commentedAt }
          : {}),
        ...(bumpUnread ? { unreadCount: { increment: 1 } } : {}),
      },
    });

    const msg = await this.prisma.cskhInboxMessage.upsert({
      where: { fbMessageId: input.fbCommentId },
      create: {
        conversationId: conv.id,
        fbMessageId: input.fbCommentId,
        direction: input.direction,
        senderType: input.direction === 'outbound' ? 'staff' : 'customer',
        text: input.text,
        messageType: input.messageType || 'text',
        attachmentUrl: input.attachmentUrl ?? null,
        sentAt: input.commentedAt,
        status: 'sent',
        tenantId: input.tenantId,
      },
      update: {
        text: input.text,
        sentAt: input.commentedAt,
        ...(input.messageType ? { messageType: input.messageType } : {}),
        ...(input.attachmentUrl !== undefined
          ? { attachmentUrl: input.attachmentUrl }
          : {}),
      },
    });

    // Cập nhật thời gian bình luận cuối cùng của bài viết.
    await this.prisma.cskhFbPost.updateMany({
      where: { pageId: input.config.pageId, fbPostId: input.fbPostId },
      data: { lastCommentAt: input.commentedAt },
    });

    if (input.publish && (!existingMsg || newer)) {
      this.publishCommentRealtime(conv, msg);
    }
  }

  private publishCommentRealtime(
    conv: {
      id: string;
      pageId: string;
      pageName: string | null;
      participantPsid: string;
      customerName: string | null;
      customerPictureUrl: string | null;
      lastMessage: string | null;
      lastMessageAt: Date | null;
      unreadCount: number;
      awaitingLabel: boolean;
      fromAd: boolean;
      adTitle: string | null;
      adId: string | null;
      referralSource: string | null;
      kind: string;
      sourcePostId: string | null;
      sourcePermalink: string | null;
      sourceThumb: string | null;
      customerLang: string | null;
      customerLangLabel: string | null;
      tenantId: string | null;
    },
    msg: {
      id: string;
      conversationId: string;
      fbMessageId: string | null;
      direction: string;
      senderType: string;
      text: string;
      messageType: string;
      attachmentUrl: string | null;
      sentAt: Date;
      status: string;
    },
  ): void {
    this.realtime.publish({
      type: 'message',
      pageId: conv.pageId,
      conversationId: conv.id,
      tenantId: conv.tenantId ?? undefined,
      messages: [
        {
          id: msg.id,
          conversationId: msg.conversationId,
          fbMessageId: msg.fbMessageId,
          direction: msg.direction,
          senderType: msg.senderType,
          text: msg.text,
          messageType: msg.messageType,
          attachmentUrl: msg.attachmentUrl,
          sentAt: msg.sentAt.toISOString(),
          status: msg.status,
        },
      ],
      conversation: {
        id: conv.id,
        pageId: conv.pageId,
        pageName: conv.pageName,
        participantPsid: conv.participantPsid,
        customerName: conv.customerName,
        customerPictureUrl: conv.customerPictureUrl,
        lastMessage: conv.lastMessage,
        lastMessageAt: conv.lastMessageAt?.toISOString() ?? null,
        unreadCount: conv.unreadCount,
        awaitingLabel: conv.awaitingLabel,
        fromAd: conv.fromAd,
        adTitle: conv.adTitle,
        adId: conv.adId,
        referralSource: conv.referralSource,
        kind: conv.kind,
        sourcePostId: conv.sourcePostId,
        sourcePermalink: conv.sourcePermalink,
        sourceThumb: conv.sourceThumb,
        customerLang: conv.customerLang,
        customerLangLabel: conv.customerLangLabel,
      },
    });
  }

  /**
   * reply là hàm để trả lời bình luận của page Facebook.
   */
  async reply(
    pageId: string,
    fbCommentId: string,
    message: string,
    tenantId?: string,
  ) {
    const config = await this.getFbPageConfig(pageId, tenantId);
    // Kiểm tra xem bình luận có tồn tại không.
    const existing = await this.prisma.cskhFbComment.findUnique({
      where: { fbCommentId },
    });
    if (!existing || existing.pageId !== pageId) {
      throw new NotFoundException('Không tìm thấy bình luận.');
    }
    // Kiểm tra xem bình luận có bị ẩn không.
    if (existing.hidden) {
      throw new BadRequestException('Không thể trả lời bình luận đã ẩn.');
    }
    // Xác định id của bình luận gốc.
    const targetId = existing.parentFbCommentId || existing.fbCommentId;
    let res: { id?: string };
    try {
      // Trả lời bình luận của page Facebook.
      res = await this.graph.replyPageComment(
        targetId,
        config.pageAccessToken,
        message.trim(),
      );
    } catch (e) {
      this.rethrowGraphOrBusy(e);
    }
    const newId = String(res.id || '').trim();
    // Xác định thời gian bình luận.
    const commentedAt = new Date();
    const tid = this.effectiveTenantId(config, tenantId);
    if (newId) {
      await this.prisma.cskhFbComment.create({
        data: {
          pageId,
          fbPostId: existing.fbPostId,
          fbCommentId: newId,
          parentFbCommentId: targetId,
          text: message.trim(),
          authorName: config.pageName,
          authorFbId: pageId,
          direction: 'outbound',
          commentedAt,
          tenantId: tid,
        },
      });
    }
    // Xác định id của người bình luận gốc.
    const threadAuthorId =
      existing.direction === 'inbound'
        ? existing.authorFbId
        : (
            await this.prisma.cskhFbComment.findFirst({
              where: {
                pageId,
                fbPostId: existing.fbPostId,
                authorFbId: { not: pageId },
                direction: 'inbound',
              },
              orderBy: { commentedAt: 'asc' },
            })
          )?.authorFbId;
    if (threadAuthorId) {
      // Lưu thread của khách gốc vào database.
      await this.upsertInboxThread({
        config,
        fbPostId: existing.fbPostId,
        threadAuthorId,
        text: message.trim(),
        commentedAt,
        fbCommentId: newId || `local-${Date.now()}`,
        direction: 'outbound',
        tenantId: tid,
      });
    }
    return { ok: true, replyId: newId || null };
  }

  async hide(pageId: string, fbCommentId: string, tenantId?: string) {
    const config = await this.getFbPageConfig(pageId, tenantId);
    // Kiểm tra xem bình luận có tồn tại không.
    const existing = await this.prisma.cskhFbComment.findUnique({
      where: { fbCommentId },
    });
    if (!existing || existing.pageId !== pageId) {
      throw new NotFoundException('Không tìm thấy bình luận.');
    }
    // Ẩn bình luận của page Facebook.
    try {
      await this.graph.hidePageComment(
        fbCommentId,
        config.pageAccessToken,
        true,
      );
    } catch (e) {
      this.rethrowGraphOrBusy(e);
    }
    // Ẩn bình luận trong database.
    await this.prisma.cskhFbComment.update({
      where: { fbCommentId },
      data: { hidden: true },
    });
    return { ok: true };
  }
}
