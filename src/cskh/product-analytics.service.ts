import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const NA = 'chưa có data';
const MISSING_SIZE = 'chưa có size';
const MISSING_COLOR = 'chưa có màu';

function formatVnd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '0đ';
  return `${Math.round(n).toLocaleString('vi-VN')}đ`;
}

function formatNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('vi-VN');
}

/** Parse size/màu từ variant.title (cùng rule FE create-order). */
export function parseSizeColor(variantTitle: string | null | undefined): {
  size: string;
  color: string;
} {
  const missingSize = MISSING_SIZE;
  const missingColor = MISSING_COLOR;
  const vt = (variantTitle || '').trim();
  if (!vt || /^default(\s+title)?$/i.test(vt)) {
    return { size: missingSize, color: missingColor };
  }

  const normSize = (t: string) => {
    if (/^(size|kích\s*thước)\b/i.test(t)) return t.replace(/^kích\s*thước\s*/i, 'Size ').trim();
    if (/^\d+(\.\d+)?$/.test(t)) return `Size ${t}`;
    if (/^\d+(\.\d+)?\s*cm$/i.test(t)) return t;
    return t;
  };
  const normColor = (t: string) => {
    if (/^màu\b/i.test(t)) return t;
    return `Màu ${t}`;
  };

  if (vt.includes('/')) {
    const parts = vt.split('/').map((p) => p.trim()).filter(Boolean);
    let size: string | null = null;
    let color: string | null = null;
    for (const part of parts) {
      if (/size|kích\s*thước|^\d+(\.\d+)?$/i.test(part)) size = normSize(part);
      else color = normColor(part);
    }
    return { size: size ?? missingSize, color: color ?? missingColor };
  }

  if (/^\d+(\.\d+)?$/.test(vt) || /^(size|kích\s*thước)\b/i.test(vt) || /\bcm$/i.test(vt)) {
    return { size: normSize(vt), color: missingColor };
  }
  if (/^màu\b/i.test(vt)) return { size: missingSize, color: vt };
  return { size: missingSize, color: normColor(vt) };
}

function uniqJoin(values: string[], missing: string): string {
  const cleaned = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  if (!cleaned.length) return missing;
  if (cleaned.every((v) => v === missing)) return missing;
  return cleaned.filter((v) => v !== missing).join(', ') || missing;
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
              { material: { contains: q, mode: 'insensitive' } },
              { variants: { some: { sku: { contains: q, mode: 'insensitive' } } } },
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

    const [totalProducts, categoriesRaw, products, filteredTotal] = await Promise.all([
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
          craftType: true,
          imageUrl: true,
          variants: {
            select: { id: true, sku: true, title: true, price: true },
            orderBy: { id: 'asc' },
            take: 40,
          },
        },
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.product.count({ where }),
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

    const items = products.map((p) => {
      const sale = salesByProduct.get(p.id.toString());
      const unitsSold = sale?.unitsSold ?? 0;
      const revenue = sale?.revenue ?? 0;
      const sku = p.variants[0]?.sku ?? p.slug;
      const parsed = p.variants.map((v) => parseSizeColor(v.title));
      const size = uniqJoin(
        parsed.map((x) => x.size),
        MISSING_SIZE,
      );
      const color = uniqJoin(
        parsed.map((x) => x.color),
        MISSING_COLOR,
      );
      const price = p.variants[0]?.price != null ? Number(p.variants[0].price) : null;

      return {
        productId: Number(p.id),
        code: sku,
        name: p.name,
        category: p.category || '—',
        material: p.material || '—',
        craftType: p.craftType || null,
        imageUrl: p.imageUrl,
        size,
        color,
        price,
        priceLabel: price != null ? formatVnd(price) : '—',
        variantCount: p.variants.length,
        unitsSold,
        unitsSoldLabel: formatNum(unitsSold),
        revenue,
        revenueLabel: formatVnd(revenue),
      };
    });

    const topByRevenue = [...salesByProduct.entries()]
      .map(([productId, s]) => ({ productId, ...s }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8);

    const topProductIds = topByRevenue.map((t) => BigInt(t.productId));
    const topNames =
      topProductIds.length > 0
        ? await this.prisma.product.findMany({
            where: { id: { in: topProductIds } },
            select: { id: true, name: true, imageUrl: true },
          })
        : [];
    const nameById = new Map(topNames.map((p) => [p.id.toString(), p] as const));

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

    const insights: string[] = [
      `Catalog: ${totalProducts.toLocaleString('vi-VN')} sản phẩm đang bán.`,
      productsWithSales > 0
        ? `Đã bán (đơn inbox): ${formatNum(totalUnitsSold)} SP · doanh thu ${formatVnd(totalRevenue)}.`
        : 'Chưa có đơn inbox gắn biến thể — đã bán / doanh thu đang = 0.',
    ];

    return {
      source: 'database' as const,
      kpis: [
        {
          key: 'totalProducts',
          label: 'Tổng sản phẩm',
          value: formatNum(totalProducts),
          raw: totalProducts,
          change: '',
          available: true,
        },
        {
          key: 'unitsSold',
          label: 'Đã bán',
          value: formatNum(totalUnitsSold),
          raw: totalUnitsSold,
          change: '',
          available: true,
          sub: 'từ đơn inbox',
        },
        {
          key: 'revenue',
          label: 'Doanh thu',
          value: formatVnd(totalRevenue),
          raw: totalRevenue,
          change: '',
          available: true,
          sub: 'từ đơn inbox',
        },
        {
          key: 'productsWithSales',
          label: 'SP có doanh số',
          value: formatNum(productsWithSales),
          raw: productsWithSales,
          change: '',
          available: true,
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
      statusBreakdown: [] as Array<{
        key: string;
        label: string;
        count: number;
        pct: number;
        color: string;
      }>,
      charts: {
        topSold: [] as Array<{ productId: number; name: string; unitsSold: number; revenue: number }>,
        topCloseRate: [] as Array<{ productId: number; name: string; closeRate: number }>,
      },
      insights,
      naLabel: NA,
    };
  }
}
