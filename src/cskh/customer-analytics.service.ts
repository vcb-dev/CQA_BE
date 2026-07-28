import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

function formatVnd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '0đ';
  return `${Math.round(n).toLocaleString('vi-VN')}đ`;
}

function formatNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('vi-VN');
}

function maskPhone(phone: string | null | undefined): string | null {
  const p = (phone || '').replace(/\s+/g, '').trim();
  if (!p) return null;
  if (p.length <= 6) return p;
  return `${p.slice(0, 4)} *** ${p.slice(-3)}`;
}

function customerKey(input: {
  participantPsid?: string | null;
  conversationId?: string | null;
  phone?: string | null;
  id: string;
}): string {
  const psid = input.participantPsid?.trim();
  if (psid) return `psid:${psid}`;
  if (input.conversationId) return `conv:${input.conversationId}`;
  const phone = input.phone?.trim();
  if (phone) return `phone:${phone}`;
  return `order:${input.id}`;
}

type ConvInfo = {
  id: string;
  pageId: string;
  pageName: string | null;
  participantPsid: string;
  customerName: string | null;
  customerPictureUrl: string | null;
  fromAd: boolean;
  adTitle: string | null;
  referralSource: string | null;
  lastMessageAt: Date | null;
  statusLabels: Array<{ name: string; color: string; sortOrder: number }>;
};

@Injectable()
export class CustomerAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async listCustomers(params: {
    tenantId?: string;
    q?: string;
    pageId?: string;
    status?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const q = params.q?.trim().toLowerCase() || '';
    const pageIdFilter = params.pageId?.trim() || '';
    const statusFilter = params.status?.trim() || '';
    const tenantId = params.tenantId;

    const orders = await this.prisma.sapoInboxOrder.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        conversationId: true,
        participantPsid: true,
        customerName: true,
        phone: true,
        address: true,
        totalPrice: true,
        createdAt: true,
      },
    });

    const conversationIds = [
      ...new Set(orders.map((o) => o.conversationId).filter(Boolean) as string[]),
    ];
    const psids = [
      ...new Set(
        orders
          .map((o) => o.participantPsid?.trim())
          .filter((v): v is string => Boolean(v)),
      ),
    ];

    const convWhere: Prisma.CskhInboxConversationWhereInput = {
      AND: [
        {
          OR: [
            ...(conversationIds.length ? [{ id: { in: conversationIds } }] : []),
            ...(psids.length ? [{ participantPsid: { in: psids } }] : []),
          ],
        },
        ...(tenantId
          ? [{ OR: [{ tenantId }, { tenantId: null }] }]
          : []),
      ],
    };

    const convRows =
      conversationIds.length || psids.length
        ? await this.prisma.cskhInboxConversation.findMany({
            where: convWhere,
            select: {
              id: true,
              pageId: true,
              pageName: true,
              participantPsid: true,
              customerName: true,
              customerPictureUrl: true,
              fromAd: true,
              adTitle: true,
              referralSource: true,
              lastMessageAt: true,
              labelAssignments: {
                where: { label: { type: 'status', isActive: true } },
                select: {
                  label: { select: { name: true, color: true, sortOrder: true } },
                },
              },
            },
          })
        : [];

    const convById = new Map<string, ConvInfo>();
    const convByPsid = new Map<string, ConvInfo>();
    for (const c of convRows) {
      const info: ConvInfo = {
        id: c.id,
        pageId: c.pageId,
        pageName: c.pageName,
        participantPsid: c.participantPsid,
        customerName: c.customerName,
        customerPictureUrl: c.customerPictureUrl,
        fromAd: c.fromAd,
        adTitle: c.adTitle,
        referralSource: c.referralSource,
        lastMessageAt: c.lastMessageAt,
        statusLabels: c.labelAssignments
          .map((a) => ({
            name: a.label.name,
            color: a.label.color,
            sortOrder: a.label.sortOrder,
          }))
          .sort((a, b) => a.sortOrder - b.sortOrder),
      };
      convById.set(c.id, info);
      convByPsid.set(c.participantPsid, info);
    }

    type Agg = {
      key: string;
      conversationId: string | null;
      participantPsid: string | null;
      customerName: string;
      phone: string | null;
      address: string | null;
      orderCount: number;
      totalSpend: number;
      lastOrderAt: Date;
      firstOrderAt: Date;
    };

    const resolveConv = (order: {
      conversationId: string | null;
      participantPsid: string | null;
    }) =>
      (order.conversationId ? convById.get(order.conversationId) : undefined) ||
      (order.participantPsid?.trim()
        ? convByPsid.get(order.participantPsid.trim())
        : undefined);

    const aggMap = new Map<string, Agg>();
    for (const order of orders) {
      const conv = resolveConv(order);
      if (pageIdFilter && (!conv || conv.pageId !== pageIdFilter)) continue;

      const key = customerKey({
        participantPsid: order.participantPsid || conv?.participantPsid,
        conversationId: order.conversationId || conv?.id,
        phone: order.phone,
        id: order.id,
      });
      const spend = Number(order.totalPrice) || 0;
      const existing = aggMap.get(key);
      if (!existing) {
        aggMap.set(key, {
          key,
          conversationId: order.conversationId || conv?.id || null,
          participantPsid: order.participantPsid?.trim() || conv?.participantPsid || null,
          customerName: order.customerName || conv?.customerName || 'Khách Messenger',
          phone: order.phone?.trim() || null,
          address: order.address?.trim() || null,
          orderCount: 1,
          totalSpend: spend,
          lastOrderAt: order.createdAt,
          firstOrderAt: order.createdAt,
        });
        continue;
      }
      existing.orderCount += 1;
      existing.totalSpend += spend;
      if (order.createdAt > existing.lastOrderAt) {
        existing.lastOrderAt = order.createdAt;
        if (order.customerName) existing.customerName = order.customerName;
        if (order.phone?.trim()) existing.phone = order.phone.trim();
        if (order.address?.trim()) existing.address = order.address.trim();
        if (order.conversationId) existing.conversationId = order.conversationId;
      }
      if (order.createdAt < existing.firstOrderAt) existing.firstOrderAt = order.createdAt;
      if (!existing.phone && order.phone?.trim()) existing.phone = order.phone.trim();
      if (!existing.address && order.address?.trim()) existing.address = order.address.trim();
    }

    if (aggMap.size === 0) {
      const realCustomers = await this.prisma.customer.findMany({
        orderBy: { createdAt: 'desc' },
        take: 200,
      });

      for (const c of realCustomers) {
        const key = `cust:${c.id}`;
        aggMap.set(key, {
          key,
          conversationId: null,
          participantPsid: null,
          customerName: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'Khách hàng',
          phone: c.phone || null,
          address: null,
          orderCount: 1,
          totalSpend: 0,
          lastOrderAt: c.createdAt || new Date(),
          firstOrderAt: c.createdAt || new Date(),
        });
      }
    }

    // Channel options from all orders (ignore page/status/q filters)
    const channelSeen = new Map<string, Set<string>>();
    const channelNames = new Map<string, string>();
    for (const order of orders) {
      const conv = resolveConv(order);
      if (!conv?.pageId) continue;
      const key = customerKey({
        participantPsid: order.participantPsid || conv.participantPsid,
        conversationId: order.conversationId || conv.id,
        phone: order.phone,
        id: order.id,
      });
      if (!channelSeen.has(conv.pageId)) channelSeen.set(conv.pageId, new Set());
      channelSeen.get(conv.pageId)!.add(key);
      channelNames.set(conv.pageId, conv.pageName || `Page ${conv.pageId}`);
    }

    let items = [...aggMap.values()]
      .map((agg) => {
        const conv =
          (agg.conversationId ? convById.get(agg.conversationId) : undefined) ||
          (agg.participantPsid ? convByPsid.get(agg.participantPsid) : undefined);
        const statusLabels = (conv?.statusLabels ?? []).map(({ name, color }) => ({
          name,
          color,
        }));
        const primaryStatus = statusLabels[0]?.name ?? 'Đã chốt';
        const channelLabel =
          conv?.pageName || (conv?.pageId ? `Page ${conv.pageId}` : 'Không rõ kênh');
        const sourceLabel = conv?.fromAd
          ? conv.adTitle
            ? `Ads · ${conv.adTitle}`
            : conv.referralSource || 'Facebook Ads'
          : 'Organic';

        return {
          id: agg.key,
          conversationId: conv?.id ?? agg.conversationId,
          participantPsid: conv?.participantPsid ?? agg.participantPsid,
          name: (conv?.customerName || agg.customerName || 'Khách Messenger').trim(),
          pictureUrl: conv?.customerPictureUrl ?? null,
          pageId: conv?.pageId ?? null,
          pageName: conv?.pageName ?? null,
          channel: channelLabel,
          source: sourceLabel,
          fromAd: Boolean(conv?.fromAd),
          status: primaryStatus,
          statusLabels,
          phone: agg.phone,
          phoneMasked: maskPhone(agg.phone),
          address: agg.address,
          orderCount: agg.orderCount,
          orderCountLabel: formatNum(agg.orderCount),
          totalSpend: agg.totalSpend,
          totalSpendLabel: formatVnd(agg.totalSpend),
          lastOrderAt: agg.lastOrderAt.toISOString(),
          firstOrderAt: agg.firstOrderAt.toISOString(),
          lastMessageAt: conv?.lastMessageAt?.toISOString() ?? null,
        };
      })
      .sort((a, b) => b.lastOrderAt.localeCompare(a.lastOrderAt));

    if (q) {
      items = items.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.phone && c.phone.includes(q)) ||
          c.channel.toLowerCase().includes(q) ||
          c.source.toLowerCase().includes(q) ||
          (c.participantPsid && c.participantPsid.includes(q)) ||
          c.status.toLowerCase().includes(q),
      );
    }

    if (statusFilter) {
      items = items.filter(
        (c) =>
          c.status === statusFilter ||
          c.statusLabels.some((l) => l.name === statusFilter),
      );
    }

    const statusMap = new Map<string, { name: string; color: string; count: number }>();
    for (const c of items) {
      const labels = c.statusLabels.length
        ? c.statusLabels
        : [{ name: c.status, color: '#6366f1' }];
      for (const lab of labels) {
        const existing = statusMap.get(lab.name);
        if (existing) existing.count += 1;
        else statusMap.set(lab.name, { name: lab.name, color: lab.color, count: 1 });
      }
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const totalSpendAll = items.reduce((s, c) => s + c.totalSpend, 0);
    const totalOrdersAll = items.reduce((s, c) => s + c.orderCount, 0);
    const newThisMonth = items.filter((c) => new Date(c.firstOrderAt) >= monthStart).length;
    const withPhone = items.filter((c) => Boolean(c.phone)).length;
    const repeatCustomers = items.filter((c) => c.orderCount > 1).length;

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
    const pageSafe = Math.min(page, totalPages);
    const sliced = items.slice((pageSafe - 1) * pageSize, pageSafe * pageSize);

    return {
      source: 'database' as const,
      kpis: [
        {
          key: 'totalCustomers',
          label: 'Tổng khách đã chốt',
          value: formatNum(total),
          sub: 'Từ đơn inbox',
        },
        {
          key: 'newThisMonth',
          label: 'Khách mới tháng này',
          value: formatNum(newThisMonth),
          sub: 'Đơn đầu tiên trong tháng',
        },
        {
          key: 'totalOrders',
          label: 'Tổng đơn',
          value: formatNum(totalOrdersAll),
          sub: 'Đơn inbox',
        },
        {
          key: 'totalSpend',
          label: 'Tổng doanh thu',
          value: formatVnd(totalSpendAll),
          sub: 'Từ đơn inbox',
        },
        {
          key: 'repeatCustomers',
          label: 'Khách mua lại',
          value: formatNum(repeatCustomers),
          sub: '≥ 2 đơn',
        },
        {
          key: 'withPhone',
          label: 'Có số điện thoại',
          value: formatNum(withPhone),
          sub: `/ ${formatNum(total)}`,
        },
      ],
      channels: [...channelSeen.entries()]
        .map(([pageId, set]) => ({
          pageId,
          pageName: channelNames.get(pageId) || `Page ${pageId}`,
          customerCount: set.size,
        }))
        .sort(
          (a, b) =>
            b.customerCount - a.customerCount || a.pageName.localeCompare(b.pageName, 'vi'),
        ),
      statuses: [...statusMap.values()].sort(
        (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'vi'),
      ),
      items: sliced,
      pagination: {
        page: pageSafe,
        pageSize,
        total,
        totalPages,
      },
    };
  }
}
