/**
 * Sync Sapo orders → sapo_orders + sapo_order_line_items (display).
 * Fast path: skip existing + createManyAndReturn batches.
 *
 * Usage: node scripts/sapo-sync-orders-display.js
 */
const { Prisma } = require('@prisma/client');
const {
  log,
  createWritablePrisma,
  ensureWritable,
  sapoAuth,
  sapoHost,
  errInfo,
  fetchSapoOrderPages,
} = require('./lib/sapo-sync-common');

const ORDER_BATCH = 40;

function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}

function dec(raw) {
  const n = Number(raw);
  return new Prisma.Decimal(Number.isFinite(n) ? String(n) : '0');
}

function tagsOf(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

function shipOf(addr = {}) {
  return {
    shipName:
      addr.name ||
      [addr.first_name, addr.last_name].filter(Boolean).join(' ') ||
      null,
    shipPhone: addr.phone || null,
    shipCompany: addr.company || null,
    shipAddress1: addr.address1 || null,
    shipAddress2: addr.address2 || null,
    shipWard: addr.ward || null,
    shipDistrict: addr.district || null,
    shipCity: addr.city || null,
    shipProvince: addr.province || null,
    shipCountry: addr.country || addr.country_name || null,
    shipZip: addr.zip || null,
  };
}

function billOf(addr = {}) {
  return {
    billName:
      addr.name ||
      [addr.first_name, addr.last_name].filter(Boolean).join(' ') ||
      null,
    billPhone: addr.phone || null,
    billAddress1: addr.address1 || null,
    billDistrict: addr.district || null,
    billCity: addr.city || null,
    billProvince: addr.province || null,
    billCountry: addr.country || addr.country_name || null,
  };
}

function inferSapoStatus(raw, listStatus) {
  if (raw.cancelled_on || listStatus === 'cancelled') return 'cancelled';
  if (raw.closed_on || listStatus === 'closed') return 'closed';
  return 'open';
}

function orderRow(raw, listStatus, customerIdBySapo) {
  const ship = shipOf(raw.shipping_address || {});
  const bill = billOf(raw.billing_address || {});
  const cust = raw.customer || {};
  const customerSapoId = cust.id ? Number(cust.id) : null;
  const customerId = customerSapoId
    ? customerIdBySapo.get(customerSapoId) ?? null
    : null;
  const customerName =
    [cust.first_name, cust.last_name].filter(Boolean).join(' ').trim() ||
    ship.shipName ||
    null;
  const lineItems = raw.line_items || [];
  const itemQuantity = lineItems.reduce((s, li) => s + (li.quantity || 0), 0);
  const shippingPrice = (raw.shipping_lines || []).reduce(
    (s, l) => s + Number(l.price || 0),
    0,
  );

  return {
    order: {
      sapoId: BigInt(raw.id),
      code: String(raw.name || `SAPO-${raw.id}`),
      orderNumber:
        raw.order_number != null
          ? Number(raw.order_number)
          : raw.number != null
            ? Number(raw.number)
            : null,
      sapoStatus: inferSapoStatus(raw, listStatus),
      financialStatus: raw.financial_status || null,
      fulfillmentStatus: raw.fulfillment_status || null,
      gateway: raw.gateway || (raw.payment_gateway_names || [])[0] || null,
      sourceName: raw.source_name || raw.source || null,
      currency: raw.currency || 'VND',
      email: raw.email || cust.email || null,
      phone: raw.phone || cust.phone || ship.shipPhone || null,
      note: raw.note || null,
      tags: tagsOf(raw.tags),
      cancelReason: raw.cancel_reason || null,
      customerSapoId: customerSapoId != null ? BigInt(customerSapoId) : null,
      customerName,
      customerId,
      subtotalPrice: dec(raw.subtotal_price),
      totalLineItemsPrice: dec(raw.total_line_items_price),
      totalDiscounts: dec(raw.total_discounts),
      totalTax: dec(raw.total_tax),
      totalShippingPrice: dec(raw.total_shipping_price ?? shippingPrice),
      totalPrice: dec(raw.total_price),
      totalOutstanding: dec(raw.total_outstanding),
      unpaidAmount: dec(raw.unpaid_amount),
      totalReceived: dec(raw.total_received),
      totalRefunded: dec(raw.total_refunded),
      itemQuantity,
      createdOn: parseDate(raw.created_on),
      modifiedOn: parseDate(raw.modified_on),
      paidOn: parseDate(raw.paid_on),
      cancelledOn: parseDate(raw.cancelled_on),
      closedOn: parseDate(raw.closed_on),
      expectedDeliveryDate: parseDate(raw.expected_delivery_date),
      ...ship,
      ...bill,
      syncedAt: new Date(),
    },
    items: lineItems.map((li) => ({
      sapoLineItemId: li.id ? BigInt(li.id) : null,
      productSapoId: li.product_id ? BigInt(li.product_id) : null,
      variantSapoId: li.variant_id ? BigInt(li.variant_id) : null,
      title: li.title || null,
      variantTitle: li.variant_title || null,
      name: li.name || null,
      sku: li.sku || null,
      vendor: li.vendor || null,
      unit: li.unit || null,
      quantity: li.quantity || 0,
      price: dec(li.price),
      totalDiscount: dec(li.total_discount),
      discountedTotal: dec(li.discounted_total ?? li.original_total),
      fulfillmentStatus: li.fulfillment_status || null,
      requiresShipping: li.requires_shipping !== false,
      taxable: li.taxable !== false,
    })),
    sapoId: Number(raw.id),
  };
}

async function insertOrderBatch(prisma, rows, existing) {
  let inserted = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i += ORDER_BATCH) {
    const chunk = rows.slice(i, i + ORDER_BATCH);
    try {
      const created = await prisma.sapoOrder.createManyAndReturn({
        data: chunk.map((r) => r.order),
        skipDuplicates: true,
      });
      const idBySapo = new Map(
        created.map((o) => [Number(o.sapoId), o.id]),
      );
      const itemRows = [];
      for (const r of chunk) {
        const orderId = idBySapo.get(r.sapoId);
        if (!orderId) {
          // already existed → skipped by createMany
          if (existing.has(r.sapoId)) skipped++;
          else {
            existing.add(r.sapoId);
            skipped++;
          }
          continue;
        }
        existing.add(r.sapoId);
        inserted++;
        for (const it of r.items) {
          itemRows.push({ ...it, orderId });
        }
      }
      if (itemRows.length) {
        await prisma.sapoOrderLineItem.createMany({
          data: itemRows,
          skipDuplicates: true,
        });
      }
    } catch (e) {
      // fallback one-by-one for this chunk
      for (const r of chunk) {
        if (existing.has(r.sapoId)) {
          skipped++;
          continue;
        }
        try {
          await prisma.sapoOrder.create({
            data: {
              ...r.order,
              items: r.items.length ? { create: r.items } : undefined,
            },
          });
          existing.add(r.sapoId);
          inserted++;
        } catch (e2) {
          if (e2.code === 'P2002') {
            existing.add(r.sapoId);
            skipped++;
          } else {
            failed++;
            if (failed <= 20 || failed % 100 === 0) {
              log(JSON.stringify({ fail: r.sapoId, ...errInfo(e2) }));
            }
          }
        }
      }
    }
  }

  return { inserted, failed, skipped };
}

async function main() {
  const prisma = await createWritablePrisma();
  const host = sapoHost();
  const auth = sapoAuth();

  const customerIdBySapo = new Map(
    (await prisma.sapoCustomer.findMany({ select: { id: true, sapoId: true } })).map(
      (r) => [Number(r.sapoId), r.id],
    ),
  );

  const existing = new Set(
    (await prisma.sapoOrder.findMany({ select: { sapoId: true } })).map((r) =>
      Number(r.sapoId),
    ),
  );

  log(
    JSON.stringify({
      host,
      existingOrders: existing.size,
      sapoCustomers: customerIdBySapo.size,
    }),
  );

  let fetched = 0;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  for (const listStatus of ['open', 'closed', 'cancelled']) {
    await fetchSapoOrderPages({
      host,
      auth,
      status: listStatus,
      delayMs: 20,
      onPage: async ({ batch, page, window }) => {
        await ensureWritable(prisma);
        fetched += batch.length;

        const rows = [];
        for (const raw of batch) {
          const sapoId = raw.id;
          if (!sapoId) continue;
          if (existing.has(sapoId)) {
            skipped++;
            continue;
          }
          rows.push(orderRow(raw, listStatus, customerIdBySapo));
        }

        if (rows.length) {
          const r = await insertOrderBatch(prisma, rows, existing);
          inserted += r.inserted;
          failed += r.failed;
          skipped += r.skipped;
        }

        log(
          JSON.stringify({
            pageDone: `${listStatus}/${page}`,
            window,
            batch: batch.length,
            fetched,
            inserted,
            skipped,
            failed,
          }),
        );
      },
    });
  }

  const dbCount = await prisma.sapoOrder.count();
  log(
    JSON.stringify({ done: true, fetched, inserted, skipped, failed, dbCount }),
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
