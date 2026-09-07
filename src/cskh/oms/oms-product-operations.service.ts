import { Injectable, Logger } from '@nestjs/common';
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
  week?: string;
  day?: string;
  categoryId?: string;
  locationId?: string;
  topLimit?: number;
  stockoutPage?: number;
  stockoutPageSize?: number;
}

export type ProductOperationsPeriodType = 'month' | 'week' | 'day';

export interface ProductOperationsPeriod {
  type: ProductOperationsPeriodType;
  value: string;
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
  orderCount: number;
  revenue: number;
}

interface RevenueSummary {
  totalRevenue: number;
  totalProducts: number;
}

interface FullDashboard {
  period: ProductOperationsPeriod;
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
  revenueSummary: RevenueSummary;
}

const PERIOD_NOUN: Record<ProductOperationsPeriodType, string> = {
  day: 'ngày',
  week: 'tuần',
  month: 'tháng',
};

function periodPrevSuffix(type: ProductOperationsPeriodType): string {
  return `so với ${PERIOD_NOUN[type]} trước`;
}

function pctCaption(pct: number | undefined, suffix: string): string {
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

/** "YYYY-Www" (ISO week) -> [thứ Hai, Chủ Nhật] của tuần đó. */
function isoWeekToDateRange(week: string): { from: string; to: string } {
  const [yearStr, weekStr] = week.split('-W');
  const year = Number(yearStr);
  const weekNum = Number(weekStr);
  // ISO 8601: tuần 1 là tuần chứa thứ Năm đầu tiên của năm.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7; // Mon=1..Sun=7
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow + 1);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (weekNum - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { from: fmt(monday), to: fmt(sunday) };
}

/** Chọn đúng 1 trong day/week/month theo thứ tự ưu tiên khớp với hợp đồng của OMS. */
function resolvePeriod(query: ProductOperationsQuery): ProductOperationsPeriod {
  if (query.day) return { type: 'day', value: query.day };
  if (query.week) return { type: 'week', value: query.week };
  return { type: 'month', value: query.month || currentMonthValue() };
}

function periodToDateRange(period: ProductOperationsPeriod): {
  from: string;
  to: string;
} {
  if (period.type === 'day') return { from: period.value, to: period.value };
  if (period.type === 'week') return isoWeekToDateRange(period.value);
  return monthToDateRange(period.value);
}

function mapReport(
  period: ProductOperationsPeriod,
  r: OmsProductOperationsReport,
): FullDashboard {
  const topCategory = [
    ...(r.additional_metrics.category_distribution ?? []),
  ].sort((a, b) => b.pct - a.pct)[0];
  const noun = PERIOD_NOUN[period.type];
  const prevSuffix = periodPrevSuffix(period.type);

  return {
    period,
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
      // {
      //   key: 'revenue',
      //   label: `Doanh thu theo ${noun}`,
      //   value: `${Math.round(r.additional_metrics.revenue.value).toLocaleString('vi-VN')}đ`,
      //   caption: pctCaption(r.additional_metrics.revenue.change_pct, prevSuffix),
      // },
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
        caption: `Chậm luân chuyển trong ${noun}`,
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
        caption: `Theo sản phẩm, trong ${noun}`,
      },
    ],
  };
}

/** Báo cáo vận hành sản phẩm theo tháng — proxy trực tiếp từ OMS, không lưu DB. */
@Injectable()
export class OmsProductOperationsService {
  private readonly logger = new Logger(OmsProductOperationsService.name);
  private cache = new Map<string, { at: number; data: FullDashboard }>();
  private revenueCache = new Map<
    string,
    { at: number; data: { items: TopRevenueProduct[]; summary: RevenueSummary } }
  >();

  constructor(private readonly omsApi: OmsApiService) {}

  private async getFullDashboard(
    period: ProductOperationsPeriod,
    query: ProductOperationsQuery,
  ): Promise<FullDashboard> {
    const cacheKey = `${period.type}:${period.value}|${query.categoryId ?? ''}|${query.locationId ?? ''}|${query.topLimit ?? ''}`;

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < REPORT_TTL_MS) {
      return cached.data;
    }

    const raw = await this.omsApi.get<OmsProductOperationsReport>(
      '/reports/product-monthly-ops',
      {
        month: period.type === 'month' ? period.value : undefined,
        week: period.type === 'week' ? period.value : undefined,
        day: period.type === 'day' ? period.value : undefined,
        category_id: query.categoryId,
        location_id: query.locationId,
        top_limit: query.topLimit,
      },
    );

    const mapped = mapReport(period, raw);
    this.cache.set(cacheKey, { at: Date.now(), data: mapped });
    return mapped;
  }

  /** Doanh thu theo sản phẩm — report "sales-revenue-by-product" của OMS, không hỗ trợ lọc category_id. */
  private async getTopRevenueProducts(
    period: ProductOperationsPeriod,
    locationId?: string,
  ): Promise<{ items: TopRevenueProduct[]; summary: RevenueSummary }> {
    const cacheKey = `${period.type}:${period.value}|${locationId ?? ''}`;
    const cached = this.revenueCache.get(cacheKey);
    if (cached && Date.now() - cached.at < REPORT_TTL_MS) {
      return cached.data;
    }

    const { from, to } = periodToDateRange(period);
    let raw: OmsRevenueByProductResponse;
    try {
      raw = await this.omsApi.get<OmsRevenueByProductResponse>(
        '/reports/sales-revenue-by-product',
        {
          from,
          to,
          location_id: locationId,
          page: 1,
          page_size: TOP_REVENUE_LIMIT,
        },
      );
    } catch (err) {
      // Không để report phụ (top doanh thu) làm sập cả dashboard vận hành chính.
      this.logger.warn(
        `Bỏ qua top doanh thu SP — OMS lỗi: ${err instanceof Error ? err.message : err}`,
      );
      return { items: [], summary: { totalRevenue: 0, totalProducts: 0 } };
    }

    const items = (raw.data ?? []).map((row) => ({
      name: row.label,
      sku: row.sku,
      quantity: row.quantity,
      orderCount: row.order_count,
      revenue: row.total_price,
    }));
    const result = {
      items,
      summary: {
        totalRevenue: raw.summary?.total_price ?? items.reduce((s, p) => s + p.revenue, 0),
        totalProducts: raw.total ?? items.length,
      },
    };
    this.revenueCache.set(cacheKey, { at: Date.now(), data: result });
    return result;
  }

  async getDashboard(
    query: ProductOperationsQuery,
  ): Promise<ProductOperationsDashboard> {
    const period = resolvePeriod(query);
    const [full, revenue] = await Promise.all([
      this.getFullDashboard(period, query),
      this.getTopRevenueProducts(period, query.locationId),
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
      topRevenueProducts: revenue.items,
      revenueSummary: revenue.summary,
    };
  }
}
