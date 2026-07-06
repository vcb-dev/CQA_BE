import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { CskhInboxConversation, CskhInboxLabel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CskhInboxRealtimeService,
  type InboxConversationPayload,
} from './cskh-inbox-realtime.service';
import {
  findInboxConversationById,
  isInboxSchemaMigrationError,
  isPrismaPoolTimeout,
} from './cskh-inbox-conversation.util';

export type InboxLabelDto = {
  id: string
  name: string
  color: string
  type: 'staff' | 'status'
  userId: number | null
  sortOrder: number
}

export type InboxViewerDto = {
  userId: number
  fullName: string
  avatarUrl: string | null
  viewedAt: string
  hasChot: boolean
}

const DEFAULT_STATUS_LABELS: Array<{ name: string; color: string; sortOrder: number }> = [
  { name: 'Kích đơn', color: '#059669', sortOrder: 1 },
  { name: 'Đã chốt', color: '#7c3aed', sortOrder: 2 },
  { name: 'Follow', color: '#d97706', sortOrder: 3 },
  { name: 'Hẹn gọi lại', color: '#2563eb', sortOrder: 4 },
  { name: 'Không mua', color: '#64748b', sortOrder: 5 },
];

const STAFF_COLORS = [
  '#6366f1',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#8b5cf6',
  '#0ea5e9',
  '#ef4444',
  '#84cc16',
];

@Injectable()
export class CskhInboxLabelsService {
  private readonly logger = new Logger(CskhInboxLabelsService.name);
  private readonly labelsEnsuredAt = new Map<string, number>();
  private readonly labelsEnsureTtlMs = Number(process.env.CSKH_LABELS_ENSURE_TTL_MS || 300_000);
  private readonly viewHistoryCache = new Map<
    string,
    {
      at: number;
      data: { viewers: InboxViewerDto[]; withoutChot: InboxViewerDto[] };
    }
  >();
  private readonly viewHistoryCacheTtlMs = Number(
    process.env.CSKH_VIEW_HISTORY_CACHE_MS || 60_000,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: CskhInboxRealtimeService,
  ) {}

  private formatLabel(row: CskhInboxLabel): InboxLabelDto {
    return {
      id: row.id,
      name: row.name,
      color: row.color,
      type: row.type as 'staff' | 'status',
      userId: row.userId,
      sortOrder: row.sortOrder,
    };
  }

  private formatConvPayload(
    conv: CskhInboxConversation,
    labels: InboxLabelDto[],
    viewers?: InboxViewerDto[],
  ): InboxConversationPayload {
    return {
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
      labels,
      viewers,
      labelsLocked: labels.length > 0,
    };
  }

  private staffColor(userId: number): string {
    return STAFF_COLORS[Math.abs(userId) % STAFF_COLORS.length];
  }

  private async upsertLabelByName(
    tenantId: string | undefined,
    data: { name: string; color: string; type: string; sortOrder: number; userId?: number },
  ) {
    const tid = tenantId ?? null;
    const existing = await this.prisma.cskhInboxLabel.findFirst({
      where: {
        tenantId: tid,
        type: data.type,
        name: data.name,
      },
    });
    if (existing) {
      await this.prisma.cskhInboxLabel.update({
        where: { id: existing.id },
        data: {
          color: data.color,
          sortOrder: data.sortOrder,
          isActive: true,
          ...(data.userId != null ? { userId: data.userId } : {}),
        },
      });
      return;
    }
    await this.prisma.cskhInboxLabel.create({
      data: {
        tenantId: tid,
        name: data.name,
        color: data.color,
        type: data.type,
        sortOrder: data.sortOrder,
        userId: data.userId ?? null,
      },
    });
  }

  private async upsertStaffLabel(
    tenantId: string | undefined,
    userId: number,
    name: string,
    color: string,
    sortOrder: number,
  ) {
    const tid = tenantId ?? null;
    const existing = await this.prisma.cskhInboxLabel.findFirst({
      where: { tenantId: tid, type: 'staff', userId },
    });
    if (existing) {
      await this.prisma.cskhInboxLabel.update({
        where: { id: existing.id },
        data: { name, color, sortOrder, isActive: true },
      });
      return;
    }
    await this.prisma.cskhInboxLabel.create({
      data: {
        tenantId: tid,
        name,
        color,
        type: 'staff',
        userId,
        sortOrder,
      },
    });
  }

  async ensureLabelsForTenant(tenantId?: string): Promise<void> {
    const cacheKey = tenantId ?? '__default__';
    const last = this.labelsEnsuredAt.get(cacheKey) ?? 0;
    if (Date.now() - last < this.labelsEnsureTtlMs) return;

    for (const item of DEFAULT_STATUS_LABELS) {
      await this.upsertLabelByName(tenantId, {
        name: item.name,
        color: item.color,
        type: 'status',
        sortOrder: item.sortOrder,
      });
    }

    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        ...(tenantId ? { tenantId } : {}),
      },
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
    });

    let order = 100;
    for (const user of users) {
      const name = user.fullName?.trim() || `NV #${user.id}`;
      await this.upsertStaffLabel(tenantId, user.id, name, this.staffColor(user.id), order++);
    }
    this.labelsEnsuredAt.set(cacheKey, Date.now());
  }

  async listLabels(tenantId?: string): Promise<InboxLabelDto[]> {
    try {
      await this.ensureLabelsForTenant(tenantId);
    } catch (e) {
      if (!isPrismaPoolTimeout(e)) throw e;
      this.logger.warn('ensureLabelsForTenant skipped — connection pool busy');
    }
    try {
      const rows = await this.prisma.cskhInboxLabel.findMany({
        where: { tenantId: tenantId ?? null, isActive: true },
        orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      });
      return rows.map((r) => this.formatLabel(r));
    } catch (e) {
      if (isPrismaPoolTimeout(e)) {
        this.logger.warn('listLabels skipped — connection pool busy');
        return [];
      }
      throw e;
    }
  }

  async getLabelsForConversation(conversationId: string): Promise<InboxLabelDto[]> {
    try {
      const rows = await this.prisma.cskhInboxConversationLabel.findMany({
        where: { conversationId },
        select: {
          assignedAt: true,
          label: {
            select: {
              id: true,
              name: true,
              color: true,
              type: true,
              userId: true,
              sortOrder: true,
              isActive: true,
              tenantId: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
        orderBy: { assignedAt: 'asc' },
      });
      return rows.filter((r) => r.label.isActive).map((r) => this.formatLabel(r.label));
    } catch (e) {
      if (isInboxSchemaMigrationError(e) || isPrismaPoolTimeout(e)) return [];
      throw e;
    }
  }

  async attachLabelsMap(
    conversationIds: string[],
  ): Promise<Map<string, InboxLabelDto[]>> {
    const map = new Map<string, InboxLabelDto[]>();
    if (!conversationIds.length) return map;

    const rows = await this.prisma.cskhInboxConversationLabel.findMany({
      where: { conversationId: { in: conversationIds } },
      include: { label: true },
    });

    for (const row of rows) {
      if (!row.label.isActive) continue;
      const list = map.get(row.conversationId) ?? [];
      list.push(this.formatLabel(row.label));
      map.set(row.conversationId, list);
    }
    return map;
  }

  async getViewersForConversation(conversationId: string): Promise<InboxViewerDto[]> {
    const [assigners, rows] = await Promise.all([
      this.getLabelAssignerIds(conversationId),
      this.prisma.cskhInboxConversationView.findMany({
        where: { conversationId },
        include: {
          user: { select: { id: true, fullName: true, avatarUrl: true } },
        },
        orderBy: { viewedAt: 'desc' },
        take: 50,
      }),
    ]);
    return rows.map((row) => ({
      userId: row.user.id,
      fullName: row.user.fullName,
      avatarUrl: row.user.avatarUrl,
      viewedAt: row.viewedAt.toISOString(),
      hasChot: assigners.has(row.user.id),
    }));
  }

  async getViewHistory(conversationId: string, tenantId?: string) {
    const cacheKey = `${tenantId ?? '__all__'}:${conversationId}`;
    const cached = this.viewHistoryCache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.viewHistoryCacheTtlMs) {
      return cached.data;
    }

    const ok = await this.prisma.cskhInboxConversation.findFirst({
      where: tenantId ? { id: conversationId, tenantId } : { id: conversationId },
      select: { id: true },
    });
    if (!ok) throw new NotFoundException('Hội thoại không tồn tại hoặc không có quyền');

    const viewers = await this.getViewersForConversation(conversationId);
    const result = {
      viewers,
      withoutChot: viewers.filter((v) => !v.hasChot),
    };
    this.viewHistoryCache.set(cacheKey, { at: Date.now(), data: result });
    return result;
  }

  /** Xóa cache lịch sử xem sau khi NV mở / gán nhãn. */
  invalidateViewHistoryCache(conversationId: string, tenantId?: string) {
    this.viewHistoryCache.delete(`${tenantId ?? '__all__'}:${conversationId}`);
  }

  private async getLabelAssignerIds(conversationId: string): Promise<Set<number>> {
    const rows = await this.prisma.cskhInboxConversationLabel.findMany({
      where: { conversationId, assignedByUserId: { not: null } },
      select: { assignedByUserId: true },
    });
    return new Set(
      rows
        .map((r) => r.assignedByUserId)
        .filter((id): id is number => id != null),
    );
  }

  async attachViewersMap(
    conversationIds: string[],
  ): Promise<Map<string, InboxViewerDto[]>> {
    const map = new Map<string, InboxViewerDto[]>();
    if (!conversationIds.length) return map;

    const assignerMap = await this.getLabelAssignerIdsMap(conversationIds);

    const rows = await this.prisma.cskhInboxConversationView.findMany({
      where: { conversationId: { in: conversationIds } },
      include: {
        user: { select: { id: true, fullName: true, avatarUrl: true } },
      },
      orderBy: { viewedAt: 'desc' },
    });

    for (const row of rows) {
      const list = map.get(row.conversationId) ?? [];
      if (list.length >= 5) continue;
      const assigners = assignerMap.get(row.conversationId) ?? new Set<number>();
      list.push({
        userId: row.user.id,
        fullName: row.user.fullName,
        avatarUrl: row.user.avatarUrl,
        viewedAt: row.viewedAt.toISOString(),
        hasChot: assigners.has(row.user.id),
      });
      map.set(row.conversationId, list);
    }
    return map;
  }

  private async getLabelAssignerIdsMap(
    conversationIds: string[],
  ): Promise<Map<string, Set<number>>> {
    const map = new Map<string, Set<number>>();
    if (!conversationIds.length) return map;

    const rows = await this.prisma.cskhInboxConversationLabel.findMany({
      where: {
        conversationId: { in: conversationIds },
        assignedByUserId: { not: null },
      },
      select: { conversationId: true, assignedByUserId: true },
    });

    for (const row of rows) {
      if (row.assignedByUserId == null) continue;
      const set = map.get(row.conversationId) ?? new Set<number>();
      set.add(row.assignedByUserId);
      map.set(row.conversationId, set);
    }
    return map;
  }

  /**
   * Ghi nhận xem nền khi mở hội thoại — không fetch viewers/labels lại, không block response.
   */
  recordConversationViewLite(
    conversationId: string,
    userId: number,
    ctx: {
      pageId: string;
      tenantId: string | null;
      hasLabels: boolean;
      customerWaiting?: boolean;
    },
  ): void {
    void (async () => {
      try {
        await this.prisma.cskhInboxConversationView.upsert({
          where: { conversationId_userId: { conversationId, userId } },
          create: { conversationId, userId },
          update: { viewedAt: new Date() },
        });
        this.invalidateViewHistoryCache(conversationId, ctx.tenantId ?? undefined);
      } catch (e) {
        if (!isInboxSchemaMigrationError(e)) throw e;
        return;
      }

      const { hasLabels, pageId, tenantId, customerWaiting = false } = ctx;
      const awaitingLabel = !hasLabels && customerWaiting;
      try {
        await this.prisma.cskhInboxConversation.update({
          where: { id: conversationId },
          data: hasLabels
            ? { unreadCount: 0, awaitingLabel: false }
            : { unreadCount: 0, awaitingLabel },
        });
      } catch (e) {
        if (!isInboxSchemaMigrationError(e)) throw e;
        try {
          await this.prisma.cskhInboxConversation.update({
            where: { id: conversationId },
            data: { unreadCount: 0 },
          });
        } catch {
          /* ignore */
        }
      }

      this.realtime.publish({
        type: 'conversation',
        pageId,
        conversationId,
        conversation: {
          id: conversationId,
          unreadCount: 0,
          awaitingLabel,
          labelsLocked: hasLabels,
        },
        tenantId: tenantId || undefined,
      });
    })().catch((e) => {
      if (!isInboxSchemaMigrationError(e) && !isPrismaPoolTimeout(e)) throw e;
    });
  }

  /** Ghi nhận NV đã xem; nếu chưa gán nhãn thì giữ chờ xử lý (awaitingLabel). */
  async recordConversationView(
    conversationId: string,
    userId: number,
    tenantId?: string,
  ): Promise<{ labels: InboxLabelDto[]; viewers: InboxViewerDto[]; conversation: CskhInboxConversation }> {
    const conv = await this.assertConversationAccess(conversationId, tenantId);

    try {
      await this.prisma.cskhInboxConversationView.upsert({
        where: {
          conversationId_userId: { conversationId, userId },
        },
        create: { conversationId, userId },
        update: { viewedAt: new Date() },
      });
    } catch (e) {
      if (!isInboxSchemaMigrationError(e)) throw e;
    }

    let labels: InboxLabelDto[] = [];
    try {
      labels = await this.getLabelsForConversation(conversationId);
    } catch (e) {
      if (!isInboxSchemaMigrationError(e)) throw e;
    }
    let updatedConv: CskhInboxConversation = conv as CskhInboxConversation;

    const lastMsg = await this.prisma.cskhInboxMessage.findFirst({
      where: { conversationId },
      orderBy: { sentAt: 'desc' },
      select: { senderType: true, direction: true },
    });
    const customerWaiting =
      !labels.length &&
      (!lastMsg || (lastMsg.senderType !== 'staff' && lastMsg.direction !== 'outbound'));

    try {
      if (labels.length === 0) {
        updatedConv = await this.prisma.cskhInboxConversation.update({
          where: { id: conversationId },
          data: { awaitingLabel: customerWaiting, unreadCount: 0 },
        });
      } else {
        updatedConv = await this.prisma.cskhInboxConversation.update({
          where: { id: conversationId },
          data: { unreadCount: 0, awaitingLabel: false },
        });
      }
    } catch (e) {
      if (!isInboxSchemaMigrationError(e)) throw e;
    }

    const viewers = await this.getViewersForConversation(conversationId).catch((e) => {
      if (isInboxSchemaMigrationError(e)) return [];
      throw e;
    });
    const payload = this.formatConvPayload(updatedConv, labels, viewers);
    this.realtime.publish({
      type: 'conversation',
      pageId: conv.pageId,
      conversationId: conv.id,
      conversation: payload,
      tenantId: conv.tenantId || undefined,
    });

    return { labels, viewers, conversation: updatedConv };
  }

  private async assertStaffLabelNotLocked(
    conversationId: string,
    label: CskhInboxLabel,
    labelId: string,
  ) {
    if (label.type !== 'staff') return;

    const staffLabelIds = await this.prisma.cskhInboxLabel.findMany({
      where: {
        tenantId: label.tenantId,
        type: 'staff',
        isActive: true,
      },
      select: { id: true },
    });
    const assignedStaff = await this.prisma.cskhInboxConversationLabel.findFirst({
      where: {
        conversationId,
        labelId: { in: staffLabelIds.map((l) => l.id) },
      },
    });
    if (assignedStaff && assignedStaff.labelId !== labelId) {
      throw new BadRequestException(
        'Đã gán nhân viên chốt — không thể đổi, phải theo đến cùng',
      );
    }
  }

  private async assertConversationAccess(conversationId: string, tenantId?: string) {
    const conv = await findInboxConversationById(this.prisma, conversationId, tenantId);
    if (!conv) throw new NotFoundException('Hội thoại không tồn tại hoặc không có quyền');
    return conv;
  }

  async toggleConversationLabel(
    conversationId: string,
    labelId: string,
    actorUserId: number,
    tenantId?: string,
  ): Promise<InboxLabelDto[]> {
    const conv = await this.assertConversationAccess(conversationId, tenantId);

    const label = await this.prisma.cskhInboxLabel.findFirst({
      where: {
        id: labelId,
        isActive: true,
        ...(tenantId ? { tenantId } : {}),
      },
    });
    if (!label) throw new NotFoundException('Nhãn không tồn tại');

    const existing = await this.prisma.cskhInboxConversationLabel.findUnique({
      where: {
        conversationId_labelId: { conversationId, labelId },
      },
    });

    if (existing) {
      throw new BadRequestException('Nhãn đã gán không thể gỡ — phải theo đến cùng');
    }

    await this.assertStaffLabelNotLocked(conversationId, label, labelId);

    if (label.type === 'staff') {
      const staffLabelIds = await this.prisma.cskhInboxLabel.findMany({
        where: {
          tenantId: label.tenantId,
          type: 'staff',
          isActive: true,
        },
        select: { id: true },
      });
      await this.prisma.cskhInboxConversationLabel.deleteMany({
        where: {
          conversationId,
          labelId: { in: staffLabelIds.map((l) => l.id) },
        },
      });
    }

    await this.prisma.cskhInboxConversationLabel.create({
      data: {
        conversationId,
        labelId,
        assignedByUserId: actorUserId,
      },
    });

    const updatedConv = await this.prisma.cskhInboxConversation.update({
      where: { id: conversationId },
      data: { unreadCount: 0, awaitingLabel: false },
    });

    const labels = await this.getLabelsForConversation(conversationId);
    const viewers = await this.getViewersForConversation(conversationId);
    const payload = this.formatConvPayload(updatedConv, labels, viewers);
    this.realtime.publish({
      type: 'conversation',
      pageId: conv.pageId,
      conversationId: conv.id,
      conversation: payload,
      tenantId: conv.tenantId || undefined,
    });

    return labels;
  }

  async setConversationLabels(
    conversationId: string,
    labelIds: string[],
    actorUserId: number,
    tenantId?: string,
  ): Promise<InboxLabelDto[]> {
    await this.assertConversationAccess(conversationId, tenantId);
    const uniqueIds = [...new Set(labelIds)];

    const labels = await this.prisma.cskhInboxLabel.findMany({
      where: {
        id: { in: uniqueIds },
        isActive: true,
        ...(tenantId ? { tenantId } : {}),
      },
    });
    if (labels.length !== uniqueIds.length) {
      throw new BadRequestException('Một hoặc nhiều nhãn không hợp lệ');
    }

    const staffCount = labels.filter((l) => l.type === 'staff').length;
    if (staffCount > 1) {
      throw new BadRequestException('Chỉ được gán một nhãn nhân viên chốt');
    }

    await this.prisma.cskhInboxConversationLabel.deleteMany({
      where: { conversationId },
    });

    if (uniqueIds.length) {
      await this.prisma.cskhInboxConversationLabel.createMany({
        data: uniqueIds.map((labelId) => ({
          conversationId,
          labelId,
          assignedByUserId: actorUserId,
        })),
      });
    }

    return this.getLabelsForConversation(conversationId);
  }
}
