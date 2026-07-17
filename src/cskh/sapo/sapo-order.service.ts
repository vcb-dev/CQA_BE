import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SapoCatalogDbService } from './sapo-catalog-db.service';
import { SapoProductService } from './sapo-product.service';

export type CreateSapoOrderInput = {
  customerName: string;
  phone?: string;
  address?: string;
  note?: string;
  psid?: string;
  conversationId?: string;
  lineItems: Array<{ variantId: number; quantity: number }>;
};

export type CreateSapoOrderResult = {
  orderId: number;
  orderName: string | null;
  totalPrice: string | null;
  adminUrl: string | null;
  source: 'db';
};

@Injectable()
export class SapoOrderService {
  private readonly logger = new Logger(SapoOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogDb: SapoCatalogDbService,
    private readonly sapoProducts: SapoProductService,
  ) {}

  isConfigured(): boolean {
    return this.catalogDb.hasCatalog();
  }

  /** Tạo đơn inbox trong DB CRM — không gọi Sapo API. */
  async createOrder(input: CreateSapoOrderInput): Promise<CreateSapoOrderResult> {
    if (!(await this.catalogDb.refreshCount())) {
      throw new BadRequestException(
        'Chưa có sản phẩm trong DB — chạy POST /cskh/products/import-from-sapo hoặc script import-sapo-products.js.',
      );
    }
    return this.createOrderInDb(input);
  }

  private async createOrderInDb(input: CreateSapoOrderInput): Promise<CreateSapoOrderResult> {
    const items = this.normalizeLineItems(input.lineItems);

    const result = await this.prisma.$transaction(async (tx) => {
      const variants = await tx.productVariant.findMany({
        where: {
          id: { in: items.map((i) => BigInt(i.variantId)) },
          enabled: true,
          product: { isPublished: true },
        },
        include: { product: true, inventoryLevels: true },
      });
      const byVariantId = new Map(variants.map((v) => [Number(v.id), v]));

      let total = new Prisma.Decimal(0);
      const orderLines: Array<{
        variantId: bigint;
        productName: string;
        unitPrice: Prisma.Decimal;
        quantity: number;
        lineTotal: Prisma.Decimal;
      }> = [];

      for (const item of items) {
        const variant = byVariantId.get(item.variantId);
        if (!variant) {
          throw new BadRequestException(`Sản phẩm #${item.variantId} không tồn tại hoặc đã ngừng bán.`);
        }
        const stock =
          variant.inventoryLevels.reduce((sum, l) => sum + (l.available ?? l.onHand), 0) ?? 0;
        if (stock < item.quantity) {
          throw new BadRequestException(
            `${variant.product.name}: chỉ còn ${stock} trong kho (yêu cầu ${item.quantity}).`,
          );
        }

        const unitPrice = variant.price;
        const lineTotal = unitPrice.mul(item.quantity);
        total = total.add(lineTotal);
        orderLines.push({
          variantId: variant.id,
          productName: variant.product.name,
          unitPrice,
          quantity: item.quantity,
          lineTotal,
        });
      }

      for (const line of orderLines) {
        const level = await tx.inventoryLevel.findFirst({
          where: { variantId: line.variantId, available: { gte: line.quantity } },
        });
        if (level) {
          await tx.inventoryLevel.update({
            where: {
              variantId_warehouseId: {
                variantId: level.variantId,
                warehouseId: level.warehouseId,
              },
            },
            data: {
              available: { decrement: line.quantity },
              onHand: { decrement: line.quantity },
            },
          });
        }
      }

      const order = await tx.sapoInboxOrder.create({
        data: {
          conversationId: input.conversationId?.trim() || null,
          participantPsid: input.psid?.trim() || null,
          customerName: (input.customerName || 'Khách Messenger').trim(),
          phone: input.phone?.trim() || null,
          address: input.address?.trim() || null,
          note: input.note?.trim() || null,
          status: 'pending',
          totalPrice: total,
          source: 'db',
          items: {
            create: orderLines.map((line) => ({
              variantId: line.variantId,
              productName: line.productName,
              unitPrice: line.unitPrice,
              quantity: line.quantity,
              lineTotal: line.lineTotal,
            })),
          },
        },
        include: { items: true },
      });

      return order;
    });

    this.sapoProducts.invalidateCache();
    await this.catalogDb.refreshCount();

    this.logger.log(`Inbox order #${result.orderNumber} total=${result.totalPrice}`);

    return {
      orderId: result.orderNumber,
      orderName: `CQA-${result.orderNumber}`,
      totalPrice: String(result.totalPrice),
      adminUrl: null,
      source: 'db',
    };
  }

  private normalizeLineItems(lineItems: CreateSapoOrderInput['lineItems']) {
    const items = (lineItems ?? [])
      .map((item) => ({
        variantId: item.variantId,
        quantity: Math.max(1, Math.floor(item.quantity || 1)),
      }))
      .filter((item) => item.variantId > 0);

    if (!items.length) {
      throw new BadRequestException('Cần ít nhất một sản phẩm để tạo đơn.');
    }
    return items;
  }
}
