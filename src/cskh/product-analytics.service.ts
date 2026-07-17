import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const NA = 'chưa có data';
const MISSING_SIZE = 'chưa có size';
const MISSING_COLOR = 'chưa có màu';
const META_TTL_MS = 90_000;

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

type SalesMeta = {
  byProduct: Map<string, { unitsSold: number; revenue: number }>;
  totalUnitsSold: number;
  totalRevenue: number;
  productsWithSales: number;
};

type CatalogMeta = {
  at: number;
  totalProducts: number;
  categories: string[];
  sales: SalesMeta;
};

@Injectable()
export class ProductAnalyticsService {
  private meta: CatalogMeta | null = null;
  private metaLoading: Promise<CatalogMeta> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private emptySales(): SalesMeta {
    return {
      byProduct: new Map(),
      totalUnitsSold: 0,
      totalRevenue: 0,
      productsWithSales: 0,
    };
  }

  private async loadSalesMeta(): Promise<SalesMeta> {
    try {
      // Fast path: không có đơn → khỏi GROUP BY nặng
      const any = await this.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT 1::int AS n FROM sapo_inbox_order_items LIMIT 1
      `;
      if (!any.length) return this.emptySales();

      const salesRows = await this.prisma.$queryRaw<
        Array<{ productId: bigint; unitsSold: number; revenue: number }>
      >`
        SELECT pv.product_id AS "productId",
               COALESCE(SUM(i.quantity), 0)::int AS "unitsSold",
               COALESCE(SUM(i.line_total), 0)::float AS revenue
        FROM sapo_inbox_order_items i
        INNER JOIN product_variants pv ON pv.id = i.variant_id
        GROUP BY pv.product_id
      `;

      const byProduct = new Map<string, { unitsSold: number; revenue: number }>();
      let totalUnitsSold = 0;
      let totalRevenue = 0;
      let productsWithSales = 0;
      for (const row of salesRows) {
        const units = Number(row.unitsSold) || 0;
        const revenue = Number(row.revenue) || 0;
        byProduct.set(row.productId.toString(), { unitsSold: units, revenue });
        totalUnitsSold += units;
        totalRevenue += revenue;
        if (units > 0) productsWithSales += 1;
      }
      return { byProduct, totalUnitsSold, totalRevenue, productsWithSales };
    } catch {
      return this.emptySales();
    }
  }

  private async refreshMeta(): Promise<CatalogMeta> {
    const [totalProducts, categoriesRaw, sales] = await Promise.all([
      this.prisma.product.count({
        where: { isPublished: true, isDiscontinued: false },
      }),
      this.prisma.$queryRaw<Array<{ category: string }>>`
        SELECT DISTINCT category
        FROM products
        WHERE is_published = true
          AND is_discontinued = false
          AND category IS NOT NULL
          AND btrim(category) <> ''
        ORDER BY category ASC
        LIMIT 200
      `.catch(async () => {
        const rows = await this.prisma.product.findMany({
          where: {
            isPublished: true,
            isDiscontinued: false,
            category: { not: null },
          },
          select: { category: true },
          distinct: ['category'],
          orderBy: { category: 'asc' },
          take: 200,
        });
        return rows
          .map((r) => r.category)
          .filter((c): c is string => Boolean(c?.trim()))
          .map((category) => ({ category }));
      }),
      this.loadSalesMeta(),
    ]);

    const categories = categoriesRaw
      .map((c) => c.category)
      .filter((c) => Boolean(c?.trim()));

    const next: CatalogMeta = {
      at: Date.now(),
      totalProducts,
      categories,
      sales,
    };
    this.meta = next;
    return next;
  }

  private async ensureMeta(): Promise<CatalogMeta> {
    if (this.meta && Date.now() - this.meta.at < META_TTL_MS) {
      return this.meta;
    }
    if (!this.metaLoading) {
      this.metaLoading = this.refreshMeta().finally(() => {
        this.metaLoading = null;
      });
    }
    return this.metaLoading;
  }

  async getDashboard(params: {
    q?: string;
    category?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(50, Math.max(10, params.pageSize ?? 20));
    const q = params.q?.trim() || '';
    const category = params.category?.trim() || '';
    const hasFilter = Boolean(q || category);
    const looksLikeSku = Boolean(q && /^[A-Za-z0-9][A-Za-z0-9._-]{2,}$/.test(q) && !/\s/.test(q));

    const where: Prisma.ProductWhereInput = {
      isPublished: true,
      isDiscontinued: false,
    };
    if (q) {
      const or: Prisma.ProductWhereInput[] = [
        { name: { contains: q, mode: 'insensitive' } },
        { slug: { contains: q, mode: 'insensitive' } },
        { category: { contains: q, mode: 'insensitive' } },
        { material: { contains: q, mode: 'insensitive' } },
      ];
      if (looksLikeSku) {
        or.push({ variants: { some: { sku: { contains: q, mode: 'insensitive' } } } });
      }
      where.OR = or;
    }
    if (category) {
      where.category = { equals: category, mode: 'insensitive' };
    }

    // Meta (KPI/categories/sales) cache 90s — không tính lại mỗi lần lật trang
    const metaPromise = this.ensureMeta();

    const productsPromise = this.prisma.product.findMany({
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
          select: { sku: true, title: true, price: true },
          orderBy: { id: 'asc' },
          take: 8,
        },
      },
      orderBy: { name: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const filteredTotalPromise = hasFilter
      ? this.prisma.product.count({ where })
      : metaPromise.then((m) => m.totalProducts);

    const [meta, products, filteredTotal] = await Promise.all([
      metaPromise,
      productsPromise,
      filteredTotalPromise,
    ]);

    const { sales } = meta;
    const items = products.map((p) => {
      const sale = sales.byProduct.get(p.id.toString());
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

    const topByRevenue = [...sales.byProduct.entries()]
      .map(([productId, s]) => ({ productId, ...s }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8);

    let topRevenue: Array<{
      rank: number;
      productId: number;
      name: string;
      imageUrl: string | null;
      unitsSold: number;
      unitsSoldLabel: string;
      revenue: number;
      revenueLabel: string;
    }> = [];

    if (topByRevenue.length) {
      const topIds = topByRevenue.map((t) => BigInt(t.productId));
      const topNames = await this.prisma.product.findMany({
        where: { id: { in: topIds } },
        select: { id: true, name: true, imageUrl: true },
      });
      const nameById = new Map(topNames.map((p) => [p.id.toString(), p] as const));
      topRevenue = topByRevenue.map((t, i) => {
        const row = nameById.get(t.productId.toString());
        return {
          rank: i + 1,
          productId: Number(t.productId),
          name: row ? row.name : `SP #${t.productId}`,
          imageUrl: row?.imageUrl ?? null,
          unitsSold: t.unitsSold,
          unitsSoldLabel: `${formatNum(t.unitsSold)} đã bán`,
          revenue: t.revenue,
          revenueLabel: formatVnd(t.revenue),
        };
      });
    }

    const insights: string[] = [
      `Catalog: ${meta.totalProducts.toLocaleString('vi-VN')} sản phẩm đang bán.`,
      sales.productsWithSales > 0
        ? `Đã bán (đơn inbox): ${formatNum(sales.totalUnitsSold)} SP · doanh thu ${formatVnd(sales.totalRevenue)}.`
        : 'Chưa có đơn inbox gắn biến thể — đã bán / doanh thu đang = 0.',
    ];

    return {
      source: 'database' as const,
      kpis: [
        {
          key: 'totalProducts',
          label: 'Tổng sản phẩm',
          value: formatNum(meta.totalProducts),
          raw: meta.totalProducts,
          change: '',
          available: true,
        },
        {
          key: 'unitsSold',
          label: 'Đã bán',
          value: formatNum(sales.totalUnitsSold),
          raw: sales.totalUnitsSold,
          change: '',
          available: true,
          sub: 'từ đơn inbox',
        },
        {
          key: 'revenue',
          label: 'Doanh thu',
          value: formatVnd(sales.totalRevenue),
          raw: sales.totalRevenue,
          change: '',
          available: true,
          sub: 'từ đơn inbox',
        },
        {
          key: 'productsWithSales',
          label: 'SP có doanh số',
          value: formatNum(sales.productsWithSales),
          raw: sales.productsWithSales,
          change: '',
          available: true,
        },
      ],
      categories: meta.categories,
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
        topSold: [] as Array<{
          productId: number;
          name: string;
          unitsSold: number;
          revenue: number;
        }>,
        topCloseRate: [] as Array<{ productId: number; name: string; closeRate: number }>,
      },
      insights,
      naLabel: NA,
    };
  }
}
