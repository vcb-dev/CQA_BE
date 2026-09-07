import { Logger } from '@nestjs/common';
import type { OmsApiService } from '../../../src/cskh/oms/oms-api.service';
import type {
  OmsProductOperationsReport,
  OmsRevenueByProductResponse,
} from '../../../src/cskh/oms/oms-api.types';
import { OmsProductOperationsService } from '../../../src/cskh/oms/oms-product-operations.service';

const OPS_PATH = '/reports/product-monthly-ops';
const REVENUE_PATH = '/reports/sales-revenue-by-product';

function opsReport(): OmsProductOperationsReport {
  return {
    period: { year: 2026, month: 9, from: '2026-09-01', to: '2026-09-30' },
    filters: { category_id: null, location_id: null },
    kpis: {
      products_ordered: { value: 120, change_pct: 5 },
      products_shipped: { value: 100, change_pct: 3 },
      ship_to_order_rate: { value: 83 },
      products_out_of_stock: { value: 4 },
    },
    top_ordered_products: [
      {
        product_id: 'p1',
        name: 'SP 1',
        category: 'Nhẫn',
        order_count: 10,
        quantity: 20,
        change_pct: 2,
      },
    ],
    out_of_stock: {
      items: [
        {
          variant_id: 'v1',
          sku: 'SKU1',
          product_name: 'SP 1',
          shortage: -3,
          available: 0,
          stuck_orders: 2,
        },
      ],
      summary: { count: 1, total_stuck_orders: 2 },
    },
    additional_metrics: {
      revenue: { value: 1_000_000, change_pct: 10 },
      category_distribution: [{ category: 'Nhẫn', revenue: 500_000, pct: 50 }],
      products_without_orders: { value: 7 },
      avg_processing_days: { value: 1.5 },
      cancel_return_rate: { value: 2 },
    },
  };
}

function revenueRow(
  label: string,
  sku: string,
  quantity: number,
  orderCount: number,
  price: number,
) {
  return {
    label,
    sku,
    quantity,
    order_count: orderCount,
    sub_total_price: price,
    total_discounts: 0,
    total_price: price,
    net_revenue: price,
  };
}

function revenueResponse(): OmsRevenueByProductResponse {
  return {
    report: { id: 'sales-revenue-by-product', name: 'Doanh thu theo SP', columns: [] },
    data: [
      revenueRow('SP 1', 'SKU1', 20, 10, 600_000),
      revenueRow('SP 2', 'SKU2', 5, 3, 150_000),
    ],
    summary: revenueRow('Tổng', '', 25, 13, 750_000),
    total: 2,
    page: 1,
    page_size: 10,
  };
}

interface RecordedCall {
  path: string;
  params: Record<string, unknown>;
}

function fakeApi(
  handler: (path: string, params: Record<string, unknown>) => unknown,
): { api: OmsApiService; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const get = jest.fn(
    async (path: string, params: Record<string, unknown> = {}) => {
      calls.push({ path, params });
      return handler(path, params);
    },
  );
  return { api: { get } as unknown as OmsApiService, calls };
}

function paramsFor(calls: RecordedCall[], path: string): Record<string, unknown> {
  const call = calls.find((c) => c.path === path);
  if (!call) throw new Error(`OMS API chưa được gọi với path ${path}`);
  return call.params;
}

describe('OmsProductOperationsService.getDashboard — chọn kỳ month/week/day', () => {
  it('day: gọi OMS với đúng day và range from = to = ngày đó', async () => {
    const { api, calls } = fakeApi((path) =>
      path === OPS_PATH ? opsReport() : revenueResponse(),
    );
    const svc = new OmsProductOperationsService(api);

    const res = await svc.getDashboard({ day: '2026-09-04' });

    expect(res.period).toEqual({ type: 'day', value: '2026-09-04' });

    const ops = paramsFor(calls, OPS_PATH);
    expect(ops.day).toBe('2026-09-04');
    expect(ops.week).toBeUndefined();
    expect(ops.month).toBeUndefined();

    const rev = paramsFor(calls, REVENUE_PATH);
    expect(rev.from).toBe('2026-09-04');
    expect(rev.to).toBe('2026-09-04');
  });

  it('week: quy đổi ISO week "2026-W01" ra thứ Hai..Chủ Nhật (2025-12-29..2026-01-04)', async () => {
    const { api, calls } = fakeApi((path) =>
      path === OPS_PATH ? opsReport() : revenueResponse(),
    );
    const svc = new OmsProductOperationsService(api);

    const res = await svc.getDashboard({ week: '2026-W01' });

    expect(res.period).toEqual({ type: 'week', value: '2026-W01' });

    const ops = paramsFor(calls, OPS_PATH);
    expect(ops.week).toBe('2026-W01');
    expect(ops.day).toBeUndefined();
    expect(ops.month).toBeUndefined();

    const rev = paramsFor(calls, REVENUE_PATH);
    expect(rev.from).toBe('2025-12-29');
    expect(rev.to).toBe('2026-01-04');
  });

  it('month: range phủ trọn tháng ("2026-02" -> 01..28)', async () => {
    const { api, calls } = fakeApi((path) =>
      path === OPS_PATH ? opsReport() : revenueResponse(),
    );
    const svc = new OmsProductOperationsService(api);

    const res = await svc.getDashboard({ month: '2026-02' });

    expect(res.period).toEqual({ type: 'month', value: '2026-02' });

    const rev = paramsFor(calls, REVENUE_PATH);
    expect(rev.from).toBe('2026-02-01');
    expect(rev.to).toBe('2026-02-28');
  });

  it('ưu tiên day > week > month khi truyền cả ba', async () => {
    const { api, calls } = fakeApi((path) =>
      path === OPS_PATH ? opsReport() : revenueResponse(),
    );
    const svc = new OmsProductOperationsService(api);

    const res = await svc.getDashboard({
      month: '2026-05',
      week: '2026-W10',
      day: '2026-09-04',
    });

    expect(res.period).toEqual({ type: 'day', value: '2026-09-04' });

    const ops = paramsFor(calls, OPS_PATH);
    expect(ops.day).toBe('2026-09-04');
    expect(ops.week).toBeUndefined();
    expect(ops.month).toBeUndefined();
  });
});

describe('OmsProductOperationsService.getDashboard — doanh thu theo sản phẩm', () => {
  it('map order_count -> orderCount và lấy tổng từ summary/total', async () => {
    const { api } = fakeApi((path) =>
      path === OPS_PATH ? opsReport() : revenueResponse(),
    );
    const svc = new OmsProductOperationsService(api);

    const res = await svc.getDashboard({ month: '2026-09' });

    expect(res.topRevenueProducts).toEqual([
      { name: 'SP 1', sku: 'SKU1', quantity: 20, orderCount: 10, revenue: 600_000 },
      { name: 'SP 2', sku: 'SKU2', quantity: 5, orderCount: 3, revenue: 150_000 },
    ]);
    expect(res.revenueSummary).toEqual({ totalRevenue: 750_000, totalProducts: 2 });
  });

  it('thiếu summary/total thì tự cộng dồn từ danh sách item', async () => {
    const { api } = fakeApi((path) => {
      if (path === OPS_PATH) return opsReport();
      return { ...revenueResponse(), summary: undefined, total: undefined };
    });
    const svc = new OmsProductOperationsService(api);

    const res = await svc.getDashboard({ month: '2026-09' });

    expect(res.revenueSummary).toEqual({ totalRevenue: 750_000, totalProducts: 2 });
  });

  it('OMS lỗi report doanh thu -> dashboard chính vẫn trả, phần doanh thu rỗng', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { api } = fakeApi((path) => {
      if (path === OPS_PATH) return opsReport();
      throw new Error('OMS 500');
    });
    const svc = new OmsProductOperationsService(api);

    const res = await svc.getDashboard({ month: '2026-09' });

    expect(res.kpis.ordered).toBe(120);
    expect(res.stockoutListCount).toBe(1);
    expect(res.topRevenueProducts).toEqual([]);
    expect(res.revenueSummary).toEqual({ totalRevenue: 0, totalProducts: 0 });
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});
