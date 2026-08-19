import { BadRequestException, Injectable } from '@nestjs/common';
import { OmsApiService } from './oms-api.service';
import type {
  OmsCustomer,
  OmsCustomersResponse,
  OmsInventoryResponse,
  OmsInventoryRow,
  OmsLocation,
  OmsLocationsResponse,
  OmsOrder,
  OmsProductDetail,
  OmsProductDetailResponse,
  OmsProductsResponse,
} from './oms-api.types';

export type OmsCatalogItem = {
  productId: string;
  variantId: string;
  name: string;
  variantTitle: string;
  sku: string | null;
  price: number;
  priceLabel: string;
  imageUrl: string | null;
  inStock: boolean;
  inventoryQuantity: number;
  locationId: string;
};

export type CreateOmsOrderInput = {
  customerName: string;
  phone?: string;
  address?: string;
  note?: string;
  conversationId?: string;
  platform?: string;
  locationId?: string;
  lineItems: Array<{ variantId: string; quantity: number; locationId?: string }>;
};

export type CreateOmsOrderResult = {
  orderId: string;
  orderName: string | null;
  totalPrice: string | null;
  source: 'oms';
};

function moneyLabel(n: number): string {
  return `${Math.round(n).toLocaleString('vi-VN')}đ`;
}

function digitsPhone(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** Chuẩn E.164 Việt Nam cho warehouse. */
export function normalizeVnPhone(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  let d = digitsPhone(raw);
  if (!d) return null;
  if (d.startsWith('84')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  if (d.length < 8) return null;
  return `+84${d}`;
}

function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = digitsPhone(a || '');
  const db = digitsPhone(b || '');
  if (!da || !db) return false;
  const tail = (s: string) => s.replace(/^84/, '').replace(/^0/, '').slice(-9);
  return tail(da) === tail(db);
}

function sourceName(platform?: string): string {
  const p = (platform || '').toLowerCase();
  if (p.includes('instagram')) return 'instagram';
  if (p.includes('tiktok')) return 'tiktokshop';
  if (p.includes('zalo')) return 'zalo';
  return 'facebook';
}

function asOrder(payload: unknown): OmsOrder {
  if (!payload || typeof payload !== 'object') return {};
  const rec = payload as Record<string, unknown>;
  if (rec.data && typeof rec.data === 'object') return rec.data as OmsOrder;
  return rec as OmsOrder;
}

@Injectable()
export class OmsOrderService {
  constructor(private readonly omsApi: OmsApiService) {}

  async searchCatalog(q?: string, page = 1): Promise<{
    ready: boolean;
    items: OmsCatalogItem[];
    total: number;
    page: number;
  }> {
    this.omsApi.assertReady();
    const location = await this.defaultLocation();
    const res = await this.omsApi.get<OmsProductsResponse>('/products', {
      q: q?.trim() || undefined,
      page: Math.max(1, page),
      page_size: 10,
      is_published: true,
    });
    const products = res.data ?? [];
    const chunks = await Promise.all(
      products.map(async (p) => {
        const [detail, inv] = await Promise.all([
          this.getProduct(p.id),
          this.getInventory(p.id),
        ]);
        return this.flattenProduct(detail, inv, location.id);
      }),
    );
    return {
      ready: true,
      items: chunks.flat(),
      total: res.total ?? products.length,
      page: res.page ?? page,
    };
  }

  async createOrder(input: CreateOmsOrderInput): Promise<CreateOmsOrderResult> {
    this.omsApi.assertReady();
    const items = (input.lineItems ?? [])
      .map((i) => ({
        variantId: String(i.variantId || '').trim(),
        quantity: Math.max(1, Math.floor(Number(i.quantity) || 1)),
        locationId: i.locationId?.trim(),
      }))
      .filter((i) => i.variantId);
    if (!items.length) {
      throw new BadRequestException('Chọn ít nhất một sản phẩm');
    }

    const location = input.locationId?.trim()
      ? { id: input.locationId.trim() }
      : await this.defaultLocation();
    const locationId = location.id;

    const customerName = input.customerName.trim() || 'Khách Messenger';
    const phone = normalizeVnPhone(input.phone);
    const customerId = await this.findOrCreateCustomer({
      name: customerName,
      phone,
      address: input.address?.trim(),
    });

    const noteParts = [
      input.note?.trim(),
      input.conversationId ? `CRM inbox ${input.conversationId}` : null,
    ].filter(Boolean);

    const body = {
      location_id: locationId,
      source_name: sourceName(input.platform),
      customer_id: customerId ?? undefined,
      name: customerName,
      phone: phone ?? undefined,
      note: noteParts.join(' · ') || undefined,
      items: items.map((i) => ({
        variant_id: i.variantId,
        location_id: i.locationId || locationId,
        quantity: i.quantity,
      })),
      shipping_address: input.address?.trim()
        ? {
            name: customerName,
            phone: phone ?? undefined,
            address1: input.address.trim(),
            country: 'Vietnam',
            country_code: 'VN',
          }
        : undefined,
    };

    const created = asOrder(await this.omsApi.post<unknown>('/orders', body));
    const orderId = String(created.id ?? created.order_id ?? '');
    if (!orderId) {
      throw new BadRequestException('Warehouse đã nhận request nhưng không trả id đơn');
    }
    const total = created.total_price;
    return {
      orderId,
      orderName: (created.name || created.order_number || null) as string | null,
      totalPrice: total == null ? null : String(total),
      source: 'oms',
    };
  }

  private async defaultLocation(): Promise<Pick<OmsLocation, 'id' | 'name'>> {
    const res = await this.omsApi.get<OmsLocationsResponse>('/locations');
    const active = (res.data ?? []).filter((l) => l.status === 'active');
    const pick = active.find((l) => l.default_location) ?? active[0] ?? res.data?.[0];
    if (!pick?.id) throw new BadRequestException('Warehouse chưa có kho (location) để tạo đơn');
    return { id: pick.id, name: pick.name };
  }

  private async getProduct(id: string): Promise<OmsProductDetail> {
    const res = await this.omsApi.get<OmsProductDetailResponse>(`/products/${encodeURIComponent(id)}`);
    return res.data;
  }

  private async getInventory(id: string): Promise<OmsInventoryRow[]> {
    const res = await this.omsApi.get<OmsInventoryResponse>(
      `/products/${encodeURIComponent(id)}/inventory`,
    );
    return res.data ?? [];
  }

  private flattenProduct(
    product: OmsProductDetail,
    inventory: OmsInventoryRow[],
    fallbackLocationId: string,
  ): OmsCatalogItem[] {
    const variants = (product.variants ?? []).filter((v) => v.enabled !== false);
    return variants.map((v) => {
      const rows = inventory.filter((r) => r.variant_id === v.id);
      const qty = rows.reduce((s, r) => s + (Number(r.available) || 0), 0);
      const loc = rows.find((r) => (r.available ?? 0) > 0)?.location_id ?? rows[0]?.location_id ?? fallbackLocationId;
      const title = (v.option_values ?? []).filter(Boolean).join(' / ') || 'Mặc định';
      return {
        productId: product.id,
        variantId: v.id,
        name: product.name,
        variantTitle: title,
        sku: v.sku?.trim() || null,
        price: Number(v.price) || 0,
        priceLabel: moneyLabel(Number(v.price) || 0),
        imageUrl: v.image_url || product.image_url,
        inStock: qty > 0,
        inventoryQuantity: qty,
        locationId: loc,
      };
    });
  }

  private async findOrCreateCustomer(opts: {
    name: string;
    phone: string | null;
    address?: string;
  }): Promise<string | null> {
    if (!opts.phone) return null;
    const found = await this.findCustomerByPhone(opts.phone);
    if (found?.id) return found.id;

    const created = await this.omsApi.post<{ data?: OmsCustomer } & OmsCustomer>('/customers', {
      first_name: opts.name,
      phone: opts.phone,
      addresses: opts.address
        ? [{ first_name: opts.name, phone: opts.phone, address1: opts.address, default: true }]
        : undefined,
    });
    const id = created.data?.id ?? created.id;
    return id ? String(id) : null;
  }

  private async findCustomerByPhone(phone: string): Promise<OmsCustomer | null> {
    const q = phone.replace(/^\+/, '');
    const res = await this.omsApi.get<OmsCustomersResponse>('/customers', { q });
    const rows = res.data ?? [];
    return rows.find((c) => phonesMatch(c.phone, phone)) ?? null;
  }
}
