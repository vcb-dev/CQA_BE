/**
 * Sync Sapo orders → CRM orders + order_items (standalone).
 * Month windows avoid Sapo page*limit > 30000.
 *
 * Usage: node scripts/sapo-sync-orders-standalone.js
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
  const prisma = await createWritablePrisma();
  const host = sapoHost();
  const auth = sapoAuth();

  const branch = await prisma.branch.findFirst({ orderBy: { id: 'asc' } });
  const user = await prisma.user.findFirst({ orderBy: { id: 'asc' } });
  const warehouse = await prisma.warehouse.findFirst({
    where: { isActive: true },
    orderBy: { id: 'asc' },
  });
  if (!branch || !user || !warehouse) {
    throw new Error('Need branch + user + warehouse');
  }

  let unlinked = await prisma.product.findUnique({
    where: { slug: 'sapo-unlinked-items' },
  });
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
    (
      await prisma.order.findMany({
        where: { sapoId: { not: null } },
        select: { sapoId: true },
      })
    ).map((r) => Number(r.sapoId)),
  );
  const customerBySapo = new Map(
    (
      await prisma.customer.findMany({
        where: { sapoId: { not: null } },
        select: { id: true, sapoId: true },
      })
    ).map((r) => [Number(r.sapoId), r.id]),
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
    (await prisma.productVariant.findMany({ select: { id: true, sku: true } })).map(
      (r) => [r.sku, r.id],
    ),
  );

  log(
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

  for (const status of ['open', 'closed', 'cancelled']) {
    await fetchSapoOrderPages({
      host,
      auth,
      status,
      delayMs: 60,
      onPage: async ({ batch, page, window }) => {
        await ensureWritable(prisma);
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
          const code = orderCode(raw.name, sapoId);
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
            } else if (
              li.variant_id &&
              variantBySku.has(`SAPO-V-${li.variant_id}`)
            ) {
              variantId = variantBySku.get(`SAPO-V-${li.variant_id}`);
            } else {
              variantId = fallbackVariant.id;
            }
            const qty = li.quantity || 0;
            const price = dec(li.price);
            itemCreates.push({
              variantId,
              warehouseId: warehouse.id,
              productName:
                (li.name || li.title || 'Sapo item').trim() || 'Sapo item',
              sku:
                (li.sku || `SAPO-V-${li.variant_id || li.id || 0}`).trim() ||
                'SAPO-UNKNOWN',
              quantity: qty,
              price,
              discount: new Prisma.Decimal(0),
              total: price.mul(qty),
            });
          }

          const baseData = {
            sapoId: BigInt(sapoId),
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
            tags:
              typeof raw.tags === 'string'
                ? raw.tags
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean)
                : Array.isArray(raw.tags)
                  ? raw.tags.map(String)
                  : [],
            orderedAt: parseDate(raw.created_on) || new Date(),
            ...(itemCreates.length ? { items: { create: itemCreates } } : {}),
          };

          try {
            await prisma.order.create({
              data: { ...baseData, code: `${code}`.slice(0, 100) },
            });
            existingOrders.add(sapoId);
            inserted++;
            items += itemCreates.length;
          } catch (e) {
            if (e.code === 'P2002') {
              try {
                await prisma.order.create({
                  data: { ...baseData, code: `SAPO-${sapoId}` },
                });
                existingOrders.add(sapoId);
                inserted++;
                items += itemCreates.length;
              } catch (e2) {
                if (e2.code === 'P2002') {
                  existingOrders.add(sapoId);
                  skipped++;
                } else {
                  failed++;
                  if (failed <= 30 || failed % 100 === 0) {
                    log(JSON.stringify({ fail: sapoId, ...errInfo(e2) }));
                  }
                }
              }
            } else {
              failed++;
              if (failed <= 30 || failed % 100 === 0) {
                log(JSON.stringify({ fail: sapoId, ...errInfo(e) }));
              }
              if (String(e.message || '').includes('read-only')) {
                await ensureWritable(prisma);
              }
            }
          }
        }

        log(
          JSON.stringify({
            pageDone: `${status}/${page}`,
            window,
            batch: batch.length,
            fetched,
            inserted,
            skipped,
            failed,
            items,
          }),
        );
      },
    });
  }

  const dbCount = await prisma.order.count({ where: { sapoId: { not: null } } });
  log(
    JSON.stringify({
      done: true,
      fetched,
      inserted,
      skipped,
      failed,
      items,
      ordersWithSapoDb: dbCount,
    }),
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
