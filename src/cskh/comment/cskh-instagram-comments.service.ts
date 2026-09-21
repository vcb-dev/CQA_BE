import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { FacebookCskhConfig, Prisma } from '@prisma/client';
import { isPrismaBusyError } from '../../common/prisma-busy.util';
import { PrismaService } from '../../prisma/prisma.service';
import { FacebookGraphService } from '../facebook/facebook-graph.service';
import { cskhInboxGraphPlatform } from '../facebook/facebook-oauth.util';
import { CskhInboxRealtimeService } from '../inbox/cskh-inbox-realtime.service';

type IgCommentWebhookValue = {
  id?: string;
  text?: string;
  parent_id?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string; media_product_type?: string };
};

/** ponytail: clip at DB column max — IG URLs/captions can exceed VarChar. */
function clipDb(
  value: string | null | undefined,
  maxLen: number,
): string | null {
  if (value == null) return null;
  const s = String(value);
  if (!s) return null;
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

@Injectable()
export class CskhInstagramCommentsService {
  private readonly logger = new Logger(CskhInstagramCommentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: FacebookGraphService,
    private readonly realtime: CskhInboxRealtimeService,
  ) {}

  /** tenant trên row media/comment — ưu tiên config kênh, fallback JWT user. */
  private effectiveTenantId(
    config: FacebookCskhConfig,
    requestTenantId?: string,
  ): string | null {
    return config.tenantId ?? requestTenantId ?? null;
  }

  private tenantScopedWhere(
    pageId: string,
    config: FacebookCskhConfig,
    requestTenantId?: string,
  ): Prisma.CskhIgMediaWhereInput {
    const tid = this.effectiveTenantId(config, requestTenantId);
    return tid ? { pageId, tenantId: tid } : { pageId };
  }

  private commentTenantWhere(
    pageId: string,
    igMediaId: string,
    config: FacebookCskhConfig,
    requestTenantId?: string,
  ): Prisma.CskhIgCommentWhereInput {
    const tid = this.effectiveTenantId(config, requestTenantId);
    return tid
      ? { pageId, igMediaId, tenantId: tid }
      : { pageId, igMediaId };
  }

  private rethrowGraphOrBusy(e: unknown): never {
    if (isPrismaBusyError(e)) {
      throw new ServiceUnavailableException(
        'Hệ thống đang bận. Thử lại sau vài giây.',
      );
    }
    const prismaCode =
      e && typeof e === 'object' && 'code' in e
        ? String((e as { code?: string }).code)
        : '';
    if (prismaCode === 'P2000') {
      throw new BadRequestException(
        'Dữ liệu media Instagram quá dài — đã cập nhật schema; chạy prisma migrate deploy rồi thử lại.',
      );
    }
    const msg = (e as Error)?.message || String(e);
    if (/\(#10\)|Application does not have permission for this action/i.test(msg)) {
      throw new BadRequestException(
        'Meta chưa cấp quyền đăng bình luận Instagram cho app (instagram_manage_comments). Trong App Dashboard bật quyền này, Development thì IG phải thuộc admin/tester, rồi Cài đặt → Kết nối lại Facebook.',
      );
    }
    if (
      /Graph API|OAuth|permission|access token|code=\(#?\d+\)|Unsupported post request|does not exist|does not support this operation|missing permissions/i.test(
        msg,
      )
    ) {
      throw new BadRequestException(
        msg.includes('Kết nối lại')
          ? msg
          : /Unsupported post request|does not support this operation/i.test(msg)
            ? 'Instagram không cho trả lời bình luận này (thường là trả lời của trả lời, hoặc thiếu quyền). Thử trả lời comment gốc, hoặc Kết nối lại Facebook trong Cài đặt.'
            : `${msg} — thử Kết nối lại Facebook (Settings) nếu vừa thêm quyền comment.`,
      );
    }
    throw e;
  }

  /** Gọi từ controller sau webhook messaging — không block ack Meta. */
  /**
   * processWebhookPayload là hàm xử lý payload từ webhook của Meta.
   * @param payload Webhook payload from Meta
   * @returns void
   */
  async processWebhookPayload(payload: unknown): Promise<void> {
    const body = payload as {
      object?: string;
      entry?: Array<{
        id?: string;
        changes?: Array<{ field?: string; value?: IgCommentWebhookValue }>;
      }>;
    };
    if (body.object !== 'instagram' || !Array.isArray(body.entry)) return;

    for (const entry of body.entry) {
      const entryId = String(entry.id || '');
      if (!entryId) continue;
      for (const change of entry.changes ?? []) {
        if (change.field !== 'comments' || !change.value) continue;
        try {
          await this.ingestCommentValue(entryId, change.value);
        } catch (e) {
          this.logger.warn(
            `IG comment webhook ingest failed entry=${entryId}: ${(e as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * resolveIgConfig là hàm giải quyết cấu hình kênh Instagram từ entryId.
   * @param entryId ID của entry trong webhook là pageId của kênh Instagram.
   * @returns Cấu hình kênh Instagram hoặc null nếu không tìm thấy
   */
  private async resolveIgConfig(
    entryId: string,
  ): Promise<FacebookCskhConfig | null> {
    // tìm cấu hình kênh Instagram theo pageId
    let cfg = await this.prisma.facebookCskhConfig.findUnique({
      where: { pageId: entryId },
    });
    if (cfg && cskhInboxGraphPlatform(cfg.metadata) === 'instagram') {
      return cfg;
    }
    // tìm cấu hình kênh Instagram theo facebookPageId
    cfg = await this.prisma.facebookCskhConfig.findFirst({
      where: {
        // tìm cấu hình kênh Instagram theo facebookPageId bằng entryId được lấy từ webhook là pageId của kênh Instagram.
        metadata: { path: ['facebookPageId'], equals: entryId },
      },
    });
    if (cfg && cskhInboxGraphPlatform(cfg.metadata) === 'instagram') {
      return cfg;
    }
    return null;
  }

  /**
   * ingestCommentValue là hàm nhập dữ liệu bình luận từ webhook của Meta.
   * @param entryId ID của entry trong webhook là pageId của kênh Instagram.
   * @param value Dữ liệu bình luận từ webhook của Meta.
   * @returns void
   */
  private async ingestCommentValue(
    entryId: string,
    value: IgCommentWebhookValue,
  ): Promise<void> {
    const igCommentId = String(value.id || '').trim();
    const igMediaId = String(value.media?.id || '').trim();
    if (!igCommentId || !igMediaId) return;

    const config = await this.resolveIgConfig(entryId);
    if (!config?.enabled || !config.pageAccessToken) return;

    const pageId = config.pageId;
    const tenantId = config.tenantId ?? undefined;
    const text = String(value.text ?? '').trim() || '(empty)';
    const commentedAt = new Date();
    const authorUsername = value.from?.username ?? undefined;
    const authorIgId = value.from?.id ?? undefined;
    const parentIgCommentId = value.parent_id ? String(value.parent_id) : null;
    const direction: 'inbound' | 'outbound' =
      authorIgId && authorIgId === pageId ? 'outbound' : 'inbound';

    const existingMedia = await this.prisma.cskhIgMedia.findUnique({
      where: { pageId_igMediaId: { pageId, igMediaId } },
      select: { permalink: true },
    });

    // Đồng bộ thông tin media Instagram:
    // - Chưa có -> tạo media mới
    // - Đã có -> cập nhật thời điểm có comment gần nhất
    await this.prisma.cskhIgMedia.upsert({
      where: { pageId_igMediaId: { pageId, igMediaId } },
      create: {
        pageId,
        igMediaId,
        mediaType: value.media?.media_product_type ?? null,
        lastCommentAt: commentedAt,
        tenantId: config.tenantId,
      },
      update: { lastCommentAt: commentedAt },
    });

    if (!existingMedia?.permalink) {
      await this.enrichMediaFromGraph(config, igMediaId);
    }

    // Đồng bộ comment Instagram:
    // - Chưa có -> tạo comment inbound
    // - Đã có -> cập nhật nội dung và thông tin tác giả
    await this.prisma.cskhIgComment.upsert({
      where: { igCommentId },
      create: {
        pageId,
        igMediaId,
        igCommentId,
        parentIgCommentId,
        text,
        authorUsername,
        authorIgId,
        direction,
        commentedAt,
        tenantId: config.tenantId,
      },
      update: {
        text,
        authorUsername,
        authorIgId,
        parentIgCommentId,
      },
    });

    this.realtime.publish({
      type: 'ig-comment',
      pageId,
      tenantId,
      conversationId: igMediaId,
      direction,
      text,
      authorUsername,
    });
  }

  /** Bổ sung caption/ảnh/permalink cho bài stub từ webhook (bài cũ chưa từng sync list). */
  private async enrichMediaFromGraph(
    config: FacebookCskhConfig,
    igMediaId: string,
  ): Promise<void> {
    try {
      const m = await this.graph.fetchInstagramMediaById(
        igMediaId,
        config.pageAccessToken,
      );
      if (!m) return;
      await this.prisma.cskhIgMedia.updateMany({
        where: { pageId: config.pageId, igMediaId },
        data: {
          mediaType: clipDb(m.media_type, 32),
          caption: m.caption ?? null,
          permalink: m.permalink ?? null,
          thumbnailUrl: m.thumbnail_url || m.media_url || null,
        },
      });
    } catch (e) {
      this.logger.warn(
        `IG media enrich ${igMediaId}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * getIgConfigForTenant là hàm lấy cấu hình kênh Instagram theo pageId và tenantId.
   * @param pageId ID của kênh Instagram.
   * @param tenantId ID của tenant.
   * @returns Cấu hình kênh Instagram.
   */
  private async getIgConfigForTenant(
    pageId: string,
    tenantId?: string,
  ): Promise<FacebookCskhConfig> {
    const config = await this.prisma.facebookCskhConfig.findUnique({
      where: { pageId },
    });
    if (!config || !config.enabled) {
      throw new NotFoundException('Không tìm thấy kênh hoặc kênh đang tắt.');
    }
    if (cskhInboxGraphPlatform(config.metadata) !== 'instagram') {
      throw new BadRequestException('pageId không phải kênh Instagram.');
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
   * listMedia là hàm lấy danh sách media Instagram theo pageId và tenantId.
   * @param pageId ID của kênh Instagram.
   * @param tenantId ID của tenant.
   * @param sync Nếu true, sẽ đồng bộ thông tin media từ Graph API.
   * @returns Danh sách media Instagram.
   */
  async listMedia(pageId: string, tenantId?: string, sync = false) {
    const config = await this.getIgConfigForTenant(pageId, tenantId);
    const where = () => this.tenantScopedWhere(pageId, config, tenantId);
    const load = () =>
      this.prisma.cskhIgMedia.findMany({
        where: where(),
        orderBy: [{ lastCommentAt: 'desc' }, { updatedAt: 'desc' }],
        take: 50,
      });

    try {
      if (sync) {
        await this.syncMediaFromGraph(config, tenantId);
      }
      let rows = await load();
      if (rows.length === 0 && !sync) {
        await this.syncMediaFromGraph(config, tenantId);
        rows = await load();
      }
      return rows;
    } catch (e) {
      this.rethrowGraphOrBusy(e);
    }
  }

  /**
   * syncMediaFromGraph là hàm đồng bộ thông tin media từ Graph API.
   * @param config Cấu hình kênh Instagram.
   * @returns void
   */
  private async syncMediaFromGraph(
    config: FacebookCskhConfig,
    requestTenantId?: string,
  ) {
    const tenantId = this.effectiveTenantId(config, requestTenantId);
    let items: Awaited<ReturnType<FacebookGraphService['fetchInstagramMedia']>>;
    try {
      items = await this.graph.fetchInstagramMedia(
        config.pageId,
        config.pageAccessToken,
        25,
      );
    } catch (e) {
      this.rethrowGraphOrBusy(e);
    }

    if (items.length === 0) return;

    await this.prisma.$transaction(
      items.map((m) => {
        const ts = m.timestamp ? new Date(m.timestamp) : null;
        const igMediaId = clipDb(m.id, 64) ?? m.id.slice(0, 64);
        return this.prisma.cskhIgMedia.upsert({
          where: {
            pageId_igMediaId: { pageId: config.pageId, igMediaId },
          },
          create: {
            pageId: config.pageId,
            igMediaId,
            mediaType: clipDb(m.media_type, 32),
            caption: m.caption ?? null,
            permalink: m.permalink ?? null,
            thumbnailUrl: m.thumbnail_url ?? null,
            lastCommentAt: ts,
            tenantId,
          },
          update: {
            mediaType: clipDb(m.media_type, 32),
            caption: m.caption ?? null,
            permalink: m.permalink ?? null,
            thumbnailUrl: m.thumbnail_url ?? null,
            ...(tenantId ? { tenantId } : {}),
          },
        });
      }),
    );
  }

  /**
   * syncComments là hàm đồng bộ thông tin comment từ Graph API.
   * @param pageId ID của kênh Instagram.
   * @param igMediaId ID của media Instagram.
   * @param tenantId ID của tenant.
   * @returns void
   */
  async syncComments(pageId: string, igMediaId: string, tenantId?: string) {
    const config = await this.getIgConfigForTenant(pageId, tenantId);
    let top: Awaited<
      ReturnType<FacebookGraphService['fetchInstagramMediaComments']>
    >;
    try {
      top = await this.graph.fetchInstagramMediaComments(
        igMediaId,
        config.pageAccessToken,
        50,
      );
    } catch (e) {
      this.rethrowGraphOrBusy(e);
    }
    const now = new Date();
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    for (const c of top) {
      ops.push(
        this.upsertGraphCommentOp(config, igMediaId, c, null, now, tenantId),
      );
      for (const r of c.replies?.data ?? []) {
        ops.push(
          this.upsertGraphCommentOp(config, igMediaId, r, c.id, now, tenantId),
        );
      }
    }
    ops.push(
      this.prisma.cskhIgMedia.updateMany({
        where: { pageId, igMediaId },
        data: { lastCommentAt: now },
      }),
    );
    try {
      if (ops.length > 0) {
        await this.prisma.$transaction(ops);
      }
    } catch (e) {
      this.rethrowGraphOrBusy(e);
    }
    return { synced: top.length };
  }

  private upsertGraphCommentOp(
    config: FacebookCskhConfig,
    igMediaId: string,
    c: {
      id: string;
      text?: string;
      timestamp?: string;
      from?: { id?: string; username?: string };
    },
    parentId: string | null,
    fallbackTime: Date,
    requestTenantId?: string,
  ) {
    const commentedAt = c.timestamp ? new Date(c.timestamp) : fallbackTime;
    const tenantId = this.effectiveTenantId(config, requestTenantId);
    return this.prisma.cskhIgComment.upsert({
      where: { igCommentId: c.id },
      create: {
        pageId: config.pageId,
        igMediaId,
        igCommentId: c.id,
        parentIgCommentId: parentId,
        text: String(c.text ?? '').trim() || '(empty)',
        authorUsername: c.from?.username ?? null,
        authorIgId: c.from?.id ?? null,
        direction: 'inbound',
        commentedAt,
        tenantId,
      },
      update: {
        text: String(c.text ?? '').trim() || '(empty)',
        authorUsername: c.from?.username ?? null,
        authorIgId: c.from?.id ?? null,
        parentIgCommentId: parentId,
      },
    });
  }

  /**
   * listComments là hàm lấy danh sách comment theo pageId và igMediaId.
   * @param pageId ID của kênh Instagram.
   * @param igMediaId ID của media Instagram.
   * @param tenantId ID của tenant.
   * @returns Danh sách comment.
   */
  async listComments(pageId: string, igMediaId: string, tenantId?: string) {
    const config = await this.getIgConfigForTenant(pageId, tenantId);
    try {
      return await this.prisma.cskhIgComment.findMany({
        where: this.commentTenantWhere(pageId, igMediaId, config, tenantId),
        orderBy: { commentedAt: 'asc' },
        take: 200,
      });
    } catch (e) {
      this.rethrowGraphOrBusy(e);
    }
  }

  /**
   * reply là hàm trả lời comment.
   * @param pageId ID của kênh Instagram.
   * @param igCommentId ID của comment.
   * @param message Nội dung trả lời.
   * @param tenantId ID của tenant.
   * @returns void
   */
  async reply(
    pageId: string,
    igCommentId: string,
    message: string,
    tenantId?: string,
  ) {
    const config = await this.getIgConfigForTenant(pageId, tenantId);
    const existing = await this.prisma.cskhIgComment.findUnique({
      where: { igCommentId },
    });
    if (!existing || existing.pageId !== pageId) {
      throw new NotFoundException('Không tìm thấy bình luận.');
    }

    if (existing.hidden) {
      throw new BadRequestException(
        'Không thể trả lời bình luận đã ẩn.',
      );
    }

    // IG chỉ 1 tầng reply — trả lời vào comment gốc nếu đang click vào reply.
    const targetCommentId = existing.parentIgCommentId || existing.igCommentId;
    let res: { id?: string };
    try {
      res = await this.graph.replyInstagramComment(
        targetCommentId,
        config.pageAccessToken,
        message.trim(),
      );
    } catch (e) {
      this.rethrowGraphOrBusy(e);
    }
    const newId = String(res.id || '').trim();
    const commentedAt = new Date();
    if (newId) {
      await this.prisma.cskhIgComment.create({
        data: {
          pageId,
          igMediaId: existing.igMediaId,
          igCommentId: newId,
          parentIgCommentId: targetCommentId,
          text: message.trim(),
          authorUsername: null,
          authorIgId: pageId,
          direction: 'outbound',
          commentedAt,
          tenantId: this.effectiveTenantId(config, tenantId),
        },
      });
    }
    await this.prisma.cskhIgMedia.updateMany({
      where: { pageId, igMediaId: existing.igMediaId },
      data: { lastCommentAt: commentedAt },
    });
    this.realtime.publish({
      type: 'ig-comment',
      pageId,
      tenantId,
      conversationId: existing.igMediaId,
      direction: 'outbound',
      text: message.trim(),
    });
    return { ok: true, replyId: newId || null };
  }

  /**
   * hide là hàm ẩn comment.
   * @param pageId ID của kênh Instagram.
   * @param igCommentId ID của comment.
   * @param tenantId ID của tenant.
   * @returns void
   */
  async hide(pageId: string, igCommentId: string, tenantId?: string) {
    const config = await this.getIgConfigForTenant(pageId, tenantId);
    const existing = await this.prisma.cskhIgComment.findUnique({
      where: { igCommentId },
    });
    if (!existing || existing.pageId !== pageId) {
      throw new NotFoundException('Không tìm thấy bình luận.');
    }
    try {
      await this.graph.hideInstagramComment(
        igCommentId,
        config.pageAccessToken,
        true,
      );
    } catch (e) {
      this.rethrowGraphOrBusy(e);
    }
    await this.prisma.cskhIgComment.update({
      where: { igCommentId },
      data: { hidden: true },
    });
    return { ok: true };
  }
}
