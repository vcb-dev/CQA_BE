import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { fetchSapoPages, parseSapoDate, parseSapoTags, toDecimalString } from './sapo-http.util';
import { isSapoApiReady } from './sapo-api.util';

type SapoLineItem = {
  id?: number;
  variant_id?: number | null;
  product_id?: number | null;
  title?: string | null;
  name?: string | null;
  sku?: string | null;
  quantity?: number;
  price?: string | number | null;
};

type SapoOrder = {
  id?: number;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  note?: string | null;
  tags?: string | string[] | null;
  cancelled_on?: string | null;
  closed_on?: string | null;
  created_on?: string | null;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  subtotal_price?: string | number | null;
  total_discounts?: string | number | null;
  total_tax?: string | number | null;
  total_price?: string | number | null;
  total_line_items_price?: string | number | null;
  total_weight?: number | null;
  shipping_lines?: Array<{ price?: string | number | null }>;
  line_items?: SapoLineItem[];
  customer?: { id?: number; email?: string | null; phone?: string | null } | null;
};

export type SapoOrderSyncResult = {
  source: 'sapo_api';
  fetched: number;
  upserted: number;
  itemsUpserted: number;
  skippedNoVariant: number;
};

@Injectable()
export class SapoOrderSyncService {
  private readonly logger = new Logger(SapoOrderSyncService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  isReady(): boolean {
    return isSapoApiReady(this.config);
  }

  /** GET /admin/orders.json theo status open|closed|cancelled (Sapo: status=any trả 0!). */
  async syncFromSapo(): Promise<SapoOrderSyncResult> {
    const ctx = await this.resolveContext();
    const statuses = ['open', 'closed', 'cancelled'] as const;
    const rows: SapoOrder[] = [];
    for (const status of statuses) {
      const batch = await fetchSapoPages<SapoOrder>({
        config: this.config,
        path: '/admin/orders.json',
        rootKey: 'orders',
        params: { status },
        maxPages: 500,
        delayMs: 100,
        onPage: ({ page, batchSize, total }) => {
          this.logger.log(`Sapo orders status=${status} page=${page} batch=${batchSize} total=${total}`);
        },
      });
      this.logger.log(`Sapo orders status=${status} fetched=${batch.length}`);
      rows.push(...batch);
    }

    let upserted = 0;
    let itemsUpserted = 0;
    let skippedNoVariant = 0;

    for (const raw of rows) {
      const sapoId = raw.id ?? 0;
      if (!sapoId) continue;

      const customerId = await this.resolveCustomerId(raw);
      const code = this.resolveOrderCode(raw.name, sapoId);
      const orderedAt = parseSapoDate(raw.created_on) ?? new Date();
      const shippingFee = (raw.shipping_lines ?? []).reduce(
        (sum, line) => sum + Number(line.price ?? 0),
        0,
      );
      const lineItems = raw.line_items ?? [];
      const totalQty = lineItems.reduce((s, li) => s + (li.quantity ?? 0), 0);
      const paymentStatus = mapPaymentStatus(raw.financial_status);
      const status = mapOrderStatus(raw);
      const subtotal = new Prisma.Decimal(toDecimalString(raw.subtotal_price ?? raw.total_line_items_price));
      const discountTotal = new Prisma.Decimal(toDecimalString(raw.total_discounts));
      const taxTotal = new Prisma.Decimal(toDecimalString(raw.total_tax));
      const totalAmount = new Prisma.Decimal(toDecimalString(raw.total_price));
      const paidAmount =
        paymentStatus === PaymentStatus.da_thanh_toan
          ? totalAmount
          : paymentStatus === PaymentStatus.mot_phan
            ? totalAmount.div(2)
            : new Prisma.Decimal(0);

      const existing = await this.prisma.order.findUnique({
        where: { sapoId: BigInt(sapoId) },
      });

      const orderData = {
        sapoId: BigInt(sapoId),
        code,
        customerId,
        branchId: ctx.branchId,
        source: 'sapo' as const,
        status,
        createdById: ctx.createdById,
        email: raw.email?.trim() || raw.customer?.email?.trim() || null,
        phone: raw.phone?.trim() || raw.customer?.phone?.trim() || null,
        subtotal,
        discountTotal,
        taxTotal,
        shippingFee: new Prisma.Decimal(String(shippingFee)),
        totalAmount,
        totalQuantity: totalQty,
        paymentStatus,
        paidAmount,
        note: raw.note?.trim() || null,
        tags: parseSapoTags(raw.tags),
        orderedAt,
      };

      let orderId: bigint;
      if (existing) {
        // Giữ code nếu đã đổi tay; chỉ update nếu code trống conflict
        const updateCode =
          existing.code === code || !(await this.prisma.order.findUnique({ where: { code } }))
            ? code
            : existing.code;
        const updated = await this.prisma.order.update({
          where: { id: existing.id },
          data: { ...orderData, code: updateCode },
        });
        orderId = updated.id;
        await this.prisma.orderItem.deleteMany({ where: { orderId } });
      } else {
        // Tránh trùng code với đơn local
        const codeTaken = await this.prisma.order.findUnique({ where: { code } });
        const finalCode = codeTaken ? `SAPO-${sapoId}` : code;
        const created = await this.prisma.order.create({
          data: { ...orderData, code: finalCode },
        });
        orderId = created.id;
      }
      upserted++;

      for (const li of lineItems) {
        const variantId = await this.resolveVariantId(li, ctx.unlinkedProductId);
        if (!variantId) {
          skippedNoVariant++;
          continue;
        }
        const qty = li.quantity ?? 0;
        const price = new Prisma.Decimal(toDecimalString(li.price));
        const total = price.mul(qty);
        await this.prisma.orderItem.create({
          data: {
            orderId,
            variantId,
            warehouseId: ctx.warehouseId,
            productName: (li.name ?? li.title ?? 'Sapo item').trim() || 'Sapo item',
            sku: (li.sku ?? `SAPO-V-${li.variant_id ?? li.id ?? 0}`).trim() || 'SAPO-UNKNOWN',
            quantity: qty,
            price,
            discount: new Prisma.Decimal(0),
            total,
          },
        });
        itemsUpserted++;
      }
    }

    this.logger.log(
      `Sapo orders sync: fetched=${rows.length} upserted=${upserted} items=${itemsUpserted} skipped=${skippedNoVariant}`,
    );
    return {
      source: 'sapo_api',
      fetched: rows.length,
      upserted,
      itemsUpserted,
      skippedNoVariant,
    };
  }

  private resolveOrderCode(name: string | null | undefined, sapoId: number): string {
    const n = (name ?? '').trim();
    if (n) return n.startsWith('#') ? `SAPO${n}` : `SAPO-${n}`;
    return `SAPO-${sapoId}`;
  }

  private async resolveCustomerId(raw: SapoOrder): Promise<bigint | null> {
    const sapoCustomerId = raw.customer?.id;
    if (sapoCustomerId) {
      const bySapo = await this.prisma.customer.findUnique({
        where: { sapoId: BigInt(sapoCustomerId) },
      });
      if (bySapo) return bySapo.id;
    }
    const phone = raw.phone?.trim() || raw.customer?.phone?.trim();
    if (phone) {
      const byPhone = await this.prisma.customer.findFirst({ where: { phone } });
      if (byPhone) return byPhone.id;
    }
    const email = raw.email?.trim() || raw.customer?.email?.trim();
    if (email) {
      const byEmail = await this.prisma.customer.findFirst({ where: { email } });
      if (byEmail) return byEmail.id;
    }
    return null;
  }

  private async resolveVariantId(
    li: SapoLineItem,
    unlinkedProductId: bigint,
  ): Promise<bigint | null> {
    if (li.variant_id) {
      const bySapo = await this.prisma.productVariant.findUnique({
        where: { sapoId: BigInt(li.variant_id) },
      });
      if (bySapo) return bySapo.id;
    }
    const sku = li.sku?.trim();
    if (sku) {
      const bySku = await this.prisma.productVariant.findUnique({ where: { sku } });
      if (bySku) return bySku.id;
    }
    if (!li.variant_id) return null;

    // Placeholder variant để không mất dòng đơn
    const placeholderSku = `SAPO-V-${li.variant_id}`;
    const existing = await this.prisma.productVariant.findUnique({
      where: { sku: placeholderSku },
    });
    if (existing) return existing.id;

    const created = await this.prisma.productVariant.create({
      data: {
        productId: unlinkedProductId,
        sapoId: BigInt(li.variant_id),
        sku: placeholderSku,
        title: (li.name ?? li.title ?? placeholderSku).trim(),
        price: new Prisma.Decimal(toDecimalString(li.price)),
        enabled: true,
      },
    });
    return created.id;
  }

  private async resolveContext(): Promise<{
    branchId: bigint;
    createdById: bigint;
    warehouseId: bigint;
    unlinkedProductId: bigint;
  }> {
    const branch = await this.prisma.branch.findFirst({ orderBy: { id: 'asc' } });
    if (!branch) throw new Error('Cần ít nhất 1 branch để sync đơn Sapo');

    const user = await this.prisma.user.findFirst({ orderBy: { id: 'asc' } });
    if (!user) throw new Error('Cần ít nhất 1 user (created_by) để sync đơn Sapo');

    const warehouse = await this.prisma.warehouse.findFirst({
      where: { isActive: true },
      orderBy: { id: 'asc' },
    });
    if (!warehouse) throw new Error('Cần ít nhất 1 warehouse để sync dòng đơn Sapo');

    let unlinked = await this.prisma.product.findUnique({
      where: { slug: 'sapo-unlinked-items' },
    });
    if (!unlinked) {
      unlinked = await this.prisma.product.create({
        data: {
          slug: 'sapo-unlinked-items',
          name: 'Sapo — SP chưa map',
          isPublished: false,
          trackInventory: false,
          salesChannels: { create: [{ channel: 'sapo' }] },
        },
      });
    }

    return {
      branchId: branch.id,
      createdById: user.id,
      warehouseId: warehouse.id,
      unlinkedProductId: unlinked.id,
    };
  }
}

function mapPaymentStatus(raw: string | null | undefined): PaymentStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'paid':
      return PaymentStatus.da_thanh_toan;
    case 'partially_paid':
    case 'partially_refunded':
      return PaymentStatus.mot_phan;
    default:
      return PaymentStatus.chua_thanh_toan;
  }
}

function mapOrderStatus(raw: SapoOrder): OrderStatus {
  if (raw.cancelled_on) return OrderStatus.cancelled;
  if (raw.closed_on) return OrderStatus.completed;
  const fulfillment = (raw.fulfillment_status ?? '').toLowerCase();
  if (fulfillment === 'fulfilled') return OrderStatus.completed;
  if (fulfillment === 'partial') return OrderStatus.processing;
  return OrderStatus.ordered;
}
