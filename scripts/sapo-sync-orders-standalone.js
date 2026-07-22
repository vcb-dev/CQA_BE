/**
 * Sync Sapo orders → orders + order_items (standalone).
 * Sapo: status=any trả 0 — phải sync open + closed + cancelled.
 *
 * Usage: node scripts/sapo-sync-orders-standalone.js
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

function hostOf(store) {
  const s = (store || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return s.includes('mysapo.net') ? s : `${s}.mysapo.net`;
}

function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}

function dec(raw, fallback = '0') {
  const n = Number(raw);
  return new Prisma.Decimal(Number.isFinite(n) ? String(n) : fallback);
}

function mapPayment(raw) {
  switch (String(raw || '').toLowerCase()) {
    case 'paid':
      return 'da_thanh_toan';
    case 'partially_paid':
    case 'partially_refunded':
      return 'mot_phan';
    default:
      return 'chua_thanh_toan';
  }
}

function mapStatus(raw) {
  if (raw.cancelled_on) return 'cancelled';
  if (raw.closed_on) return 'completed';
  const f = String(raw.fulfillment_status || '').toLowerCase();
  if (f === 'fulfilled') return 'completed';
  if (f === 'partial') return 'processing';
  return 'ordered';
}

function orderCode(name, sapoId) {
  const n = (name || '').trim();
  if (n) return n.startsWith('#') ? `SAPO${n}` : `SAPO-${n}`;
  return `SAPO-${sapoId}`;
}

async function main() {
  const prisma = new PrismaClient();
  const host = hostOf(process.env.SAPO_STORE);
  const auth = {
    username: process.env.SAPO_API_KEY || process.env.SAPO_PRIVATE_API_KEY,
    password: process.env.SAPO_API_SECRET || process.env.SAPO_PRIVATE_API_SECRET,
  };
  if (!host || !auth.username || !auth.password) {
    throw new Error('Missing SAPO credentials');
  }

  const branch = await prisma.branch.findFirst({ orderBy: { id: 'asc' } });
  const user = await prisma.user.findFirst({ orderBy: { id: 'asc' } });
  const warehouse = await prisma.warehouse.findFirst({
    where: { isActive: true },
    orderBy: { id: 'asc' },
  });
  if (!branch || !user || !warehouse) {
    throw new Error('Need branch + user + warehouse');
  }

  let unlinked = await prisma.product.findUnique({ where: { slug: 'sapo-unlinked-items' } });
  if (!unlinked) {
    unlinked = await prisma.product.create({
      data: {
        slug: 'sapo-unlinked-items',
        name: 'Sapo — SP chưa map',
        isPublished: false,
        trackInventory: false,
        salesChannels: { create: [{ channel: 'sapo' }] },
      },
    });
  }

  let fallbackVariant = await prisma.productVariant.findUnique({
    where: { sku: 'SAPO-ORDER-FALLBACK' },
  });
  if (!fallbackVariant) {
    fallbackVariant = await prisma.productVariant.create({
      data: {
        productId: unlinked.id,
        sku: 'SAPO-ORDER-FALLBACK',
        title: 'Sapo line item (unmapped)',
        price: new Prisma.Decimal(0),
        enabled: true,
      },
    });
  }

  const existingOrders = new Set(
    (await prisma.order.findMany({ where: { sapoId: { not: null } }, select: { sapoId: true } })).map(
      (r) => Number(r.sapoId),
    ),
  );
  const customerBySapo = new Map(
    (await prisma.customer.findMany({ where: { sapoId: { not: null } }, select: { id: true, sapoId: true } })).map(
      (r) => [Number(r.sapoId), r.id],
    ),
  );
  const variantBySapo = new Map(
    (
      await prisma.productVariant.findMany({
        where: { sapoId: { not: null } },
        select: { id: true, sapoId: true },
      })
    ).map((r) => [Number(r.sapoId), r.id]),
  );
  const variantBySku = new Map(
    (await prisma.productVariant.findMany({ select: { id: true, sku: true } })).map((r) => [r.sku, r.id]),
  );

  console.log(
    JSON.stringify({
      host,
      existingOrders: existingOrders.size,
      customers: customerBySapo.size,
      variantsBySapo: variantBySapo.size,
    }),
  );

  let fetched = 0;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  let items = 0;

  const statuses = ['open', 'closed', 'cancelled'];

  for (const status of statuses) {
    for (let page = 1; page <= 500; page++) {
      const { data } = await axios.get(`https://${host}/admin/orders.json`, {
        auth,
        params: { limit: 250, page, status },
        timeout: 90_000,
      });
      const batch = data.orders || [];
      if (!batch.length) break;
      fetched += batch.length;

      for (const raw of batch) {
        const sapoId = raw.id;
        if (!sapoId) continue;
        if (existingOrders.has(sapoId)) {
          skipped++;
          continue;
        }

        const customerId = raw.customer?.id
          ? customerBySapo.get(Number(raw.customer.id)) ?? null
          : null;
        const codeBase = orderCode(raw.name, sapoId);
        const code = existingOrders.has(sapoId) ? codeBase : codeBase;
        const shippingFee = (raw.shipping_lines || []).reduce(
          (s, l) => s + Number(l.price || 0),
          0,
        );
        const lineItems = raw.line_items || [];
        const paymentStatus = mapPayment(raw.financial_status);
        const totalAmount = dec(raw.total_price);
        const paidAmount =
          paymentStatus === 'da_thanh_toan'
            ? totalAmount
            : paymentStatus === 'mot_phan'
              ? totalAmount.div(2)
              : new Prisma.Decimal(0);

        const itemCreates = [];
        for (const li of lineItems) {
          let variantId = null;
          if (li.variant_id && variantBySapo.has(Number(li.variant_id))) {
            variantId = variantBySapo.get(Number(li.variant_id));
          } else if (li.sku && variantBySku.has(String(li.sku).trim())) {
            variantId = variantBySku.get(String(li.sku).trim());
          } else if (li.variant_id && variantBySku.has(`SAPO-V-${li.variant_id}`)) {
            variantId = variantBySku.get(`SAPO-V-${li.variant_id}`);
          } else {
            variantId = fallbackVariant.id;
          }
          const qty = li.quantity || 0;
          const price = dec(li.price);
          itemCreates.push({
            variantId,
            warehouseId: warehouse.id,
            productName: (li.name || li.title || 'Sapo item').trim() || 'Sapo item',
            sku: (li.sku || `SAPO-V-${li.variant_id || li.id || 0}`).trim() || 'SAPO-UNKNOWN',
            quantity: qty,
            price,
            discount: new Prisma.Decimal(0),
            total: price.mul(qty),
          });
        }

        try {
          await prisma.order.create({
            data: {
              sapoId: BigInt(sapoId),
              code: `${code}`.slice(0, 100),
              customerId,
              branchId: branch.id,
              source: 'sapo',
              status: mapStatus(raw),
              createdById: user.id,
              email: raw.email || raw.customer?.email || null,
              phone: raw.phone || raw.customer?.phone || null,
              subtotal: dec(raw.subtotal_price || raw.total_line_items_price),
              discountTotal: dec(raw.total_discounts),
              taxTotal: dec(raw.total_tax),
              shippingFee: dec(shippingFee),
              totalAmount,
              totalQuantity: lineItems.reduce((s, li) => s + (li.quantity || 0), 0),
              paymentStatus,
              paidAmount,
              note: raw.note || null,
              tags: typeof raw.tags === 'string'
                ? raw.tags.split(',').map((t) => t.trim()).filter(Boolean)
                : Array.isArray(raw.tags)
                  ? raw.tags.map(String)
                  : [],
              orderedAt: parseDate(raw.created_on) || new Date(),
              ...(itemCreates.length ? { items: { create: itemCreates } } : {}),
            },
          });
          existingOrders.add(sapoId);
          inserted++;
          items += itemCreates.length;
          if (inserted % 100 === 0) {
            console.log(
              JSON.stringify({
                status,
                page,
                fetched,
                inserted,
                skipped,
                failed,
                items,
              }),
            );
          }
        } catch (e) {
          failed++;
          // code conflict → retry with SAPO-{id}
          if (e.code === 'P2002') {
            try {
              await prisma.order.create({
                data: {
                  sapoId: BigInt(sapoId),
                  code: `SAPO-${sapoId}`,
                  customerId,
                  branchId: branch.id,
                  source: 'sapo',
                  status: mapStatus(raw),
                  createdById: user.id,
                  email: raw.email || raw.customer?.email || null,
                  phone: raw.phone || raw.customer?.phone || null,
                  subtotal: dec(raw.subtotal_price || raw.total_line_items_price),
                  discountTotal: dec(raw.total_discounts),
                  taxTotal: dec(raw.total_tax),
                  shippingFee: dec(shippingFee),
                  totalAmount,
                  totalQuantity: lineItems.reduce((s, li) => s + (li.quantity || 0), 0),
                  paymentStatus,
                  paidAmount,
                  note: raw.note || null,
                  orderedAt: parseDate(raw.created_on) || new Date(),
                  ...(itemCreates.length ? { items: { create: itemCreates } } : {}),
                },
              });
              existingOrders.add(sapoId);
              inserted++;
              items += itemCreates.length;
              failed--;
            } catch (e2) {
              if (failed <= 30 || failed % 100 === 0) {
                console.log(JSON.stringify({ fail: sapoId, code: e2.code, msg: e2.message?.slice(0, 120) }));
              }
            }
          } else if (failed <= 30 || failed % 100 === 0) {
            console.log(JSON.stringify({ fail: sapoId, code: e.code, msg: e.message?.slice(0, 120) }));
          }
        }
      }

      console.log(
        JSON.stringify({
          pageDone: `${status}/${page}`,
          batch: batch.length,
          fetched,
          inserted,
          skipped,
          failed,
          items,
        }),
      );
      if (batch.length < 250) break;
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  console.log(
    JSON.stringify({
      done: true,
      fetched,
      inserted,
      skipped,
      failed,
      items,
      ordersWithSapo: existingOrders.size,
    }),
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
