import { Injectable } from '@nestjs/common';
import { OmsApiService } from './oms-api.service';
import type {
  OmsProductOperationsReport,
  OmsRevenueByProductResponse,
} from './oms-api.types';

const REPORT_TTL_MS = 60_000;
const DEFAULT_STOCKOUT_PAGE_SIZE = 10;
const TOP_REVENUE_LIMIT = 10;

export interface ProductOperationsQuery {
  month?: string;
  categoryId?: string;
  locationId?: string;
  topLimit?: number;
  stockoutPage?: number;
  stockoutPageSize?: number;
}

interface StockoutItem {
  name: string;
  sku: string;
  shortage: number;
  available: number;
  stuckOrders: number;
}

interface TopRevenueProduct {
  name: string;
  sku: string;
  quantity: number;
  revenue: number;
}

interface FullDashboard {
  month: string;
  kpis: {
    ordered: number;
    orderedChangePct: number;
    shipped: number;
    shippedChangePct: number;
    shipToOrderRate: number;
    stockoutCount: number;
    stuckOrdersTotal: number;
  };
  topOrdered: Array<{
    rank: number;
    name: string;
    category: string;
    count: number;
    qty: number;
    changePct: number;
  }>;
  stockouts: StockoutItem[];
  extraMetrics: Array<{
    key: string;
    label: string;
    value: string;
    caption: string;
  }>;
}

export interface ProductOperationsDashboard extends Omit<
  FullDashboard,
  'stockouts'
> {
  stockouts: StockoutItem[];
  stockoutListCount: number;
  stockoutsPagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  topRevenueProducts: TopRevenueProduct[];
}

function pctCaption(
  pct: number | undefined,
  suffix = 'so với tháng trước',
): string {
  if (pct == null || !Number.isFinite(pct)) return suffix;
  return `${pct >= 0 ? '+' : ''}${pct}% ${suffix}`;
}

function currentMonthValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** "YYYY-MM" -> [ngày đầu, ngày cuối tháng đó]. */
function monthToDateRange(month: string): { from: string; to: string } {
  const [year, mon] = month.split('-').map(Number);
  const lastDay = new Date(year, mon, 0).getDate();
  return {
    from: `${month}-01`,
    to: `${month}-${String(lastDay).padStart(2, '0')}`,
  };
}

function mapReport(
  month: string,
  r: OmsProductOperationsReport,
): FullDashboard {
  const topCategory = [
    ...(r.additional_metrics.category_distribution ?? []),
  ].sort((a, b) => b.pct - a.pct)[0];

  return {
    month,
    kpis: {
      ordered: r.kpis.products_ordered.value,
      orderedChangePct: r.kpis.products_ordered.change_pct ?? 0,
      shipped: r.kpis.products_shipped.value,
      shippedChangePct: r.kpis.products_shipped.change_pct ?? 0,
      shipToOrderRate: r.kpis.ship_to_order_rate.value,
      stockoutCount: r.kpis.products_out_of_stock.value,
      stuckOrdersTotal: r.out_of_stock?.summary?.total_stuck_orders ?? 0,
    },
    topOrdered: (r.top_ordered_products ?? []).map((p, i) => ({
      rank: i + 1,
      name: p.name,
      category: p.category,
      count: p.order_count,
      qty: p.quantity,
      changePct: p.change_pct,
    })),
    stockouts: (r.out_of_stock?.items ?? []).map((s) => ({
      name: s.product_name,
      sku: s.sku,
      shortage: Math.abs(s.shortage),
      available: s.available,
      stuckOrders: s.stuck_orders,
    })),
    extraMetrics: [
      {
        key: 'revenue',
        label: 'Doanh thu theo tháng',
        value: `${Math.round(r.additional_metrics.revenue.value).toLocaleString('vi-VN')}đ`,
        caption: pctCaption(r.additional_metrics.revenue.change_pct),
      },
      {
        key: 'categoryShare',
        label: 'Phân bổ theo danh mục',
        value: topCategory
          ? `${topCategory.category} ${Math.round(topCategory.pct)}%`
          : '—',
        caption: 'Nhóm chiếm doanh thu cao nhất',
      },
      {
        key: 'noOrders',
        label: 'SP không có đơn',
        value: `${r.additional_metrics.products_without_orders.value} SP`,
        caption: 'Chậm luân chuyển trong tháng',
      },
      {
        key: 'avgProcessTime',
        label: 'T.gian xử lý TB',
        value: `${r.additional_metrics.avg_processing_days.value.toLocaleString('vi-VN')} ngày`,
        caption: 'Từ lên đơn → xuất hàng',
      },
      {
        key: 'cancelReturnRate',
        label: 'Tỉ lệ huỷ / trả',
        value: `${r.additional_metrics.cancel_return_rate.value.toLocaleString('vi-VN')}%`,
        caption: 'Theo sản phẩm, trong tháng',
      },
    ],
  };
}

/** Báo cáo vận hành sản phẩm theo tháng — proxy trực tiếp từ OMS, không lưu DB. */
@Injectable()
export class OmsProductOperationsService {
  private cache = new Map<string, { at: number; data: FullDashboard }>();
  private revenueCache = new Map<
    string,
    { at: number; data: TopRevenueProduct[] }
  >();

  constructor(private readonly omsApi: OmsApiService) {}

  private async getFullDashboard(
    month: string,
    query: ProductOperationsQuery,
  ): Promise<FullDashboard> {
    const cacheKey = `${month}|${query.categoryId ?? ''}|${query.locationId ?? ''}|${query.topLimit ?? ''}`;

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < REPORT_TTL_MS) {
      return cached.data;
    }

    const raw = await this.omsApi.get<OmsProductOperationsReport>(
      '/reports/san-pham-van-hanh-theo-thang',
      {
        month,
        category_id: query.categoryId,
        location_id: query.locationId,
        top_limit: query.topLimit,
      },
    );

    const mapped = mapReport(month, raw);
    this.cache.set(cacheKey, { at: Date.now(), data: mapped });
    return mapped;
  }

  /** Doanh thu theo sản phẩm — report riêng của OMS, không hỗ trợ lọc category_id. */
  private async getTopRevenueProducts(
    month: string,
    locationId?: string,
  ): Promise<TopRevenueProduct[]> {
    const cacheKey = `${month}|${locationId ?? ''}`;
    const cached = this.revenueCache.get(cacheKey);
    if (cached && Date.now() - cached.at < REPORT_TTL_MS) {
      return cached.data;
    }

    const { from, to } = monthToDateRange(month);
    const raw = await this.omsApi.get<OmsRevenueByProductResponse>(
      '/reports/doanh-thu-theo-san-pham',
      {
        from,
        to,
        location_id: locationId,
        page: 1,
        page_size: TOP_REVENUE_LIMIT,
      },
    );

    const mapped = (raw.data ?? []).map((row) => ({
      name: row.label,
      sku: row.sku,
      quantity: row.quantity,
      revenue: row.total_price,
    }));
    this.revenueCache.set(cacheKey, { at: Date.now(), data: mapped });
    return mapped;
  }

  async getDashboard(
    query: ProductOperationsQuery,
  ): Promise<ProductOperationsDashboard> {
    const month = query.month || currentMonthValue();
    const [full, topRevenueProducts] = await Promise.all([
      this.getFullDashboard(month, query),
      this.getTopRevenueProducts(month, query.locationId),
    ]);

    const pageSize = Math.max(
      1,
      query.stockoutPageSize ?? DEFAULT_STOCKOUT_PAGE_SIZE,
    );
    const total = full.stockouts.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, query.stockoutPage ?? 1), totalPages);
    const start = (page - 1) * pageSize;

    return {
      ...full,
      stockouts: full.stockouts.slice(start, start + pageSize),
      stockoutListCount: total,
      stockoutsPagination: { page, pageSize, total, totalPages },
      topRevenueProducts,
    };
  }
}
