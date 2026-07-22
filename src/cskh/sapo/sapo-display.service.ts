import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SapoDisplayService {
  constructor(private readonly prisma: PrismaService) {}

  async listCustomers(input: {
    q?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 20));
    const q = (input.q ?? '').trim();

    const where: Prisma.SapoCustomerWhereInput = q
      ? {
          OR: [
            { fullName: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {};

    const [total, items] = await Promise.all([
      this.prisma.sapoCustomer.count({ where }),
      this.prisma.sapoCustomer.findMany({
        where,
        orderBy: { sapoModifiedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      items: items.map((c) => ({
        ...c,
        sapoId: c.sapoId.toString(),
        id: c.id.toString(),
        lastOrderSapoId: c.lastOrderSapoId?.toString() ?? null,
        totalSpent: c.totalSpent.toString(),
        addressLabel: [c.address1, c.ward, c.district, c.province, c.city]
          .filter(Boolean)
          .join(', '),
      })),
    };
  }

  async listOrders(input: {
    q?: string;
    financialStatus?: string;
    fulfillmentStatus?: string;
    sapoStatus?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 20));
    const q = (input.q ?? '').trim();

    const where: Prisma.SapoOrderWhereInput = {
      ...(input.financialStatus
        ? { financialStatus: input.financialStatus }
        : {}),
      ...(input.fulfillmentStatus
        ? { fulfillmentStatus: input.fulfillmentStatus }
        : {}),
      ...(input.sapoStatus ? { sapoStatus: input.sapoStatus } : {}),
      ...(q
        ? {
            OR: [
              { code: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
              { email: { contains: q, mode: 'insensitive' } },
              { customerName: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      this.prisma.sapoOrder.count({ where }),
      this.prisma.sapoOrder.findMany({
        where,
        include: { items: true },
        orderBy: { createdOn: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      items: items.map((o) => ({
        id: o.id.toString(),
        sapoId: o.sapoId.toString(),
        code: o.code,
        orderNumber: o.orderNumber,
        sapoStatus: o.sapoStatus,
        financialStatus: o.financialStatus,
        fulfillmentStatus: o.fulfillmentStatus,
        gateway: o.gateway,
        sourceName: o.sourceName,
        currency: o.currency,
        email: o.email,
        phone: o.phone,
        customerName: o.customerName,
        customerSapoId: o.customerSapoId?.toString() ?? null,
        note: o.note,
        tags: o.tags,
        subtotalPrice: o.subtotalPrice.toString(),
        totalDiscounts: o.totalDiscounts.toString(),
        totalTax: o.totalTax.toString(),
        totalShippingPrice: o.totalShippingPrice.toString(),
        totalPrice: o.totalPrice.toString(),
        unpaidAmount: o.unpaidAmount.toString(),
        itemQuantity: o.itemQuantity,
        createdOn: o.createdOn,
        paidOn: o.paidOn,
        cancelledOn: o.cancelledOn,
        closedOn: o.closedOn,
        shipTo: [o.shipName, o.shipPhone, o.shipAddress1, o.shipWard, o.shipDistrict, o.shipProvince]
          .filter(Boolean)
          .join(' · '),
        items: o.items.map((li) => ({
          id: li.id.toString(),
          name: li.name,
          title: li.title,
          variantTitle: li.variantTitle,
          sku: li.sku,
          quantity: li.quantity,
          price: li.price.toString(),
          discountedTotal: li.discountedTotal.toString(),
          vendor: li.vendor,
        })),
      })),
    };
  }

  async stats() {
    const [customers, orders, open, paid] = await Promise.all([
      this.prisma.sapoCustomer.count(),
      this.prisma.sapoOrder.count(),
      this.prisma.sapoOrder.count({ where: { sapoStatus: 'open' } }),
      this.prisma.sapoOrder.count({ where: { financialStatus: 'paid' } }),
    ]);
    return { customers, orders, openOrders: open, paidOrders: paid };
  }
}
