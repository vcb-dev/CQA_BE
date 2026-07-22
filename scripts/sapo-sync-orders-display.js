/**
 * Sync Sapo orders → sapo_orders + sapo_order_line_items (bảng hiển thị).
 * status=any trả 0 → sync open + closed + cancelled.
 *
 * Usage: node scripts/sapo-sync-orders-display.js
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { PrismaClient, Prisma } = require('@prisma/client');

function loadEnv() {
  const file = path.resolve(__dirname, '../.env');
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();
if (process.env.DIRECT_URL) {
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}

function hostOf(store) {
  const s = (store || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return s.includes('mysapo.net') ? s : `${s}.mysapo.net`;
}

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
  if (typeof raw === 'string')
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  return [];
}

function shipOf(addr = {}) {
  return {
    shipName: addr.name || [addr.first_name, addr.last_name].filter(Boolean).join(' ') || null,
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
    billName: addr.name || [addr.first_name, addr.last_name].filter(Boolean).join(' ') || null,
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

async function main() {
  const prisma = new PrismaClient();
  await prisma.$executeRawUnsafe('SET default_transaction_read_only = off');
  await prisma.$executeRawUnsafe('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');
  const host = hostOf(process.env.SAPO_STORE);
  const auth = {
    username: process.env.SAPO_API_KEY || process.env.SAPO_PRIVATE_API_KEY,
    password: process.env.SAPO_API_SECRET || process.env.SAPO_PRIVATE_API_SECRET,
  };

  const customerIdBySapo = new Map(
    (
      await prisma.sapoCustomer.findMany({ select: { id: true, sapoId: true } })
    ).map((r) => [Number(r.sapoId), r.id]),
  );

  const existing = new Set(
    (await prisma.sapoOrder.findMany({ select: { sapoId: true } })).map((r) => Number(r.sapoId)),
  );

  console.log(
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
    for (let page = 1; page <= 500; page++) {
      const { data } = await axios.get(`https://${host}/admin/orders.json`, {
        auth,
        params: { limit: 250, page, status: listStatus },
        timeout: 90_000,
      });
      const batch = data.orders || [];
      if (!batch.length) break;
      fetched += batch.length;

      for (const raw of batch) {
        const sapoId = raw.id;
        if (!sapoId) continue;
        if (existing.has(sapoId)) {
          skipped++;
          continue;
        }

        const ship = shipOf(raw.shipping_address || {});
        const bill = billOf(raw.billing_address || {});
        const cust = raw.customer || {};
        const customerSapoId = cust.id ? Number(cust.id) : null;
        const customerId = customerSapoId ? customerIdBySapo.get(customerSapoId) ?? null : null;
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

        try {
          await prisma.sapoOrder.create({
            data: {
              sapoId: BigInt(sapoId),
              code: String(raw.name || `SAPO-${sapoId}`),
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
              items: {
                create: lineItems.map((li) => ({
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
              },
            },
          });
          existing.add(sapoId);
          inserted++;
          if (inserted % 100 === 0) {
            console.log(
              JSON.stringify({ listStatus, page, fetched, inserted, skipped, failed }),
            );
          }
        } catch (e) {
          failed++;
          if (failed <= 20 || failed % 100 === 0) {
            console.log(
              JSON.stringify({
                fail: sapoId,
                code: e.code,
                msg: e.message?.slice(0, 140),
              }),
            );
          }
        }
      }

      console.log(
        JSON.stringify({
          pageDone: `${listStatus}/${page}`,
          batch: batch.length,
          fetched,
          inserted,
          skipped,
          failed,
        }),
      );
      if (batch.length < 250) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  console.log(JSON.stringify({ done: true, fetched, inserted, skipped, failed }));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
