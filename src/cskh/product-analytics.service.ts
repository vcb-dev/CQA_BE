import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const NA = 'chưa có data';

function formatVnd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return NA;
  return `${Math.round(n).toLocaleString('vi-VN')}đ`;
}

function formatNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return NA;
  return Math.round(n).toLocaleString('vi-VN');
}

@Injectable()
export class ProductAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(params: {
    q?: string;
    category?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(10, params.pageSize ?? 20));
    const q = params.q?.trim() || '';
    const category = params.category?.trim() || '';

    const where: Prisma.ProductWhereInput = {
      isPublished: true,
      isDiscontinued: false,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { slug: { contains: q, mode: 'insensitive' } },
              { category: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(category ? { category: { equals: category, mode: 'insensitive' } } : {}),
    };

    let salesRows: Array<{ productId: bigint; unitsSold: number; revenue: number }> = [];
    try {
      salesRows = await this.prisma.$queryRaw`
        SELECT pv.product_id AS "productId",
               COALESCE(SUM(i.quantity), 0)::int AS "unitsSold",
               COALESCE(SUM(i.line_total), 0)::float AS revenue
        FROM sapo_inbox_order_items i
        INNER JOIN product_variants pv ON pv.id = i.variant_id
        GROUP BY pv.product_id
      `;
    } catch {
      salesRows = [];
    }

    const [totalProducts, categoriesRaw, products, filteredTotal, inboxMsgCount] =
      await Promise.all([
        this.prisma.product.count({
          where: { isPublished: true, isDiscontinued: false },
        }),
        this.prisma.product.findMany({
          where: { isPublished: true, isDiscontinued: false, category: { not: null } },
          select: { category: true },
          distinct: ['category'],
          orderBy: { category: 'asc' },
          take: 200,
        }),
        this.prisma.product.findMany({
          where,
          select: {
            id: true,
            slug: true,
            name: true,
            category: true,
            material: true,
            imageUrl: true,
            variants: { select: { id: true, sku: true, title: true }, take: 3 },
          },
          orderBy: { name: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        this.prisma.product.count({ where }),
        this.prisma.cskhInboxMessage.count().catch(() => 0),
      ]);

    const salesByProduct = new Map<string, { unitsSold: number; revenue: number }>();
    let totalUnitsSold = 0;
    let totalRevenue = 0;
    let productsWithSales = 0;
    for (const row of salesRows) {
      const key = row.productId.toString();
      const units = Number(row.unitsSold) || 0;
      const revenue = Number(row.revenue) || 0;
      salesByProduct.set(key, { unitsSold: units, revenue });
      totalUnitsSold += units;
      totalRevenue += revenue;
      if (units > 0) productsWithSales += 1;
    }

    // Phân loại tình trạng theo doanh số (dựa trên toàn bộ catalog đã bán)
    const allPublished = await this.prisma.product.findMany({
      where: { isPublished: true, isDiscontinued: false },
      select: { id: true },
    });
    let hot = 0;
    let potential = 0;
    let average = 0;
    let poor = 0;
    for (const p of allPublished) {
      const s = salesByProduct.get(p.id.toString());
      const units = s?.unitsSold ?? 0;
      if (units >= 10) hot += 1;
      else if (units >= 3) potential += 1;
      else if (units >= 1) average += 1;
      else poor += 1;
    }
    const statusTotal = allPublished.length || 1;
    const statusBreakdown = [
      { key: 'hot', label: 'Sản phẩm bán chạy', count: hot, pct: Math.round((hot / statusTotal) * 1000) / 10, color: '#22c55e' },
      { key: 'potential', label: 'Sản phẩm tiềm năng', count: potential, pct: Math.round((potential / statusTotal) * 1000) / 10, color: '#3b82f6' },
      { key: 'average', label: 'Sản phẩm trung bình', count: average, pct: Math.round((average / statusTotal) * 1000) / 10, color: '#f59e0b' },
      { key: 'poor', label: 'Sản phẩm chưa bán', count: poor, pct: Math.round((poor / statusTotal) * 1000) / 10, color: '#ef4444' },
    ];

    const items = products.map((p) => {
      const sale = salesByProduct.get(p.id.toString());
      const unitsSold = sale?.unitsSold ?? 0;
      const revenue = sale?.revenue ?? 0;
      const sku = p.variants[0]?.sku ?? p.slug;
      const variantHint = p.variants
        .map((v) => v.title)
        .filter((t) => t && !/^default/i.test(t))
        .slice(0, 2)
        .join(', ');
      return {
        productId: Number(p.id),
        code: sku,
        name: p.name,
        category: p.category || NA,
        material: p.material,
        imageUrl: p.imageUrl,
        variantHint: variantHint || null,
        messageCount: null as number | null,
        messageCountLabel: NA,
        responseRate: null as number | null,
        responseRateLabel: NA,
        closeRate: null as number | null,
        closeRateLabel: NA,
        unitsSold,
        unitsSoldLabel: formatNum(unitsSold),
        revenue,
        revenueLabel: formatVnd(revenue),
        revenuePerUnit: unitsSold > 0 ? revenue / unitsSold : null,
        revenuePerUnitLabel: unitsSold > 0 ? formatVnd(revenue / unitsSold) : NA,
        aiScore: null as number | null,
        aiScoreLabel: NA,
        trend: unitsSold > 0 ? ('up' as const) : ('flat' as const),
      };
    });

    const topByRevenue = [...salesByProduct.entries()]
      .map(([productId, s]) => ({ productId, ...s }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    const topProductIds = topByRevenue.map((t) => BigInt(t.productId));
    const topNames =
      topProductIds.length > 0
        ? await this.prisma.product.findMany({
            where: { id: { in: topProductIds } },
            select: { id: true, name: true, imageUrl: true },
          })
        : [];
    const nameById = new Map(
      topNames.map((p) => [p.id.toString(), p] as const),
    );

    const topRevenue = topByRevenue.map((t, i) => {
      const meta = nameById.get(t.productId.toString());
      return {
        rank: i + 1,
        productId: Number(t.productId),
        name: meta ? meta.name : `SP #${t.productId}`,
        imageUrl: meta?.imageUrl ?? null,
        unitsSold: t.unitsSold,
        unitsSoldLabel: `${formatNum(t.unitsSold)} đã bán`,
        revenue: t.revenue,
        revenueLabel: formatVnd(t.revenue),
      };
    });

    const chartTopSold = [...salesByProduct.entries()]
      .map(([productId, s]) => ({ productId, ...s }))
      .sort((a, b) => b.unitsSold - a.unitsSold)
      .slice(0, 10);

    const chartIds = chartTopSold.map((t) => BigInt(t.productId));
    const chartNames =
      chartIds.length > 0
        ? await this.prisma.product.findMany({
            where: { id: { in: chartIds } },
            select: { id: true, name: true },
          })
        : [];
    const chartNameById = new Map(chartNames.map((p) => [p.id.toString(), p.name]));

    const insights: string[] = [];
    if (totalProducts === 0) {
      insights.push('Chưa có sản phẩm trong database. Hãy import catalog từ Sapo.');
    } else {
      insights.push(`Hiện có ${totalProducts.toLocaleString('vi-VN')} sản phẩm đang bán trên hệ thống.`);
      if (productsWithSales > 0) {
        insights.push(
          `${productsWithSales.toLocaleString('vi-VN')} sản phẩm đã có đơn từ hội thoại (Sapo inbox), tổng ${formatNum(totalUnitsSold)} sản phẩm bán · doanh thu ${formatVnd(totalRevenue)}.`,
        );
      } else {
        insights.push('Chưa có đơn hàng inbox gắn sản phẩm — doanh thu / đã bán đang ở mức 0.');
      }
      insights.push('Tin nhắn / tỷ lệ phản hồi / tỷ lệ chốt / AI Score theo từng SP: chưa có data (chưa gắn mention SP với hội thoại).');
    }

    return {
      source: 'database' as const,
      kpis: [
        {
          key: 'totalProducts',
          label: 'Tổng sản phẩm',
          value: formatNum(totalProducts),
          raw: totalProducts,
          change: NA,
          available: true,
        },
        {
          key: 'productsWithMessages',
          label: 'Sản phẩm có tin nhắn',
          value: NA,
          raw: null,
          change: NA,
          available: false,
        },
        {
          key: 'totalMessages',
          label: 'Tổng tin nhắn inbox',
          value: formatNum(inboxMsgCount),
          raw: inboxMsgCount,
          change: NA,
          available: true,
          sub: 'toàn hệ thống (chưa tách theo SP)',
        },
        {
          key: 'unitsSold',
          label: 'Sản phẩm đã bán',
          value: formatNum(totalUnitsSold),
          raw: totalUnitsSold,
          change: NA,
          available: true,
          sub: 'từ đơn inbox',
        },
        {
          key: 'revenue',
          label: 'Doanh thu từ SP',
          value: formatVnd(totalRevenue),
          raw: totalRevenue,
          change: NA,
          available: true,
          sub: 'từ đơn inbox',
        },
        {
          key: 'avgCloseRate',
          label: 'Tỷ lệ chốt trung bình',
          value: NA,
          raw: null,
          change: NA,
          available: false,
        },
      ],
      categories: categoriesRaw
        .map((c) => c.category)
        .filter((c): c is string => Boolean(c?.trim())),
      items,
      pagination: {
        page,
        pageSize,
        total: filteredTotal,
        totalPages: Math.max(1, Math.ceil(filteredTotal / pageSize)),
      },
      topByRevenue: topRevenue,
      statusBreakdown,
      charts: {
        topSold: chartTopSold.map((t) => ({
          productId: Number(t.productId),
          name: chartNameById.get(t.productId.toString()) ?? `SP #${t.productId}`,
          unitsSold: t.unitsSold,
          revenue: t.revenue,
        })),
        topCloseRate: [] as Array<{ productId: number; name: string; closeRate: number }>,
      },
      insights,
      naLabel: NA,
    };
  }
}
