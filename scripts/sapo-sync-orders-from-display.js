/**
 * Fast CRM orders sync: sapo_orders → orders + order_items (no Sapo API).
 * Batch createManyAndReturn — much faster than per-row API sync.
 *
 * Usage: node scripts/sapo-sync-orders-from-display.js
 */
const { Prisma } = require('@prisma/client');
const {
  log,
  createWritablePrisma,
  ensureWritable,
  errInfo,
} = require('./lib/sapo-sync-common');

const PAGE = 800;
const ORDER_BATCH = 80;

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

function mapStatus(o) {
  if (o.cancelledOn || o.sapoStatus === 'cancelled') return 'cancelled';
  if (o.closedOn || o.sapoStatus === 'closed') return 'completed';
  const f = String(o.fulfillmentStatus || '').toLowerCase();
  if (f === 'fulfilled') return 'completed';
  if (f === 'partial') return 'processing';
  return 'ordered';
}

function orderCode(name, sapoId) {
  const n = (name || '').trim();
  if (n) return n.startsWith('#') ? `SAPO${n}` : `SAPO-${n}`;
  return `SAPO-${sapoId}`;
}

function dec(raw, fallback = '0') {
  if (raw == null) return new Prisma.Decimal(fallback);
  if (raw instanceof Prisma.Decimal) return raw;
  const n = Number(raw);
  return new Prisma.Decimal(Number.isFinite(n) ? String(n) : fallback);
}

async function main() {
  const prisma = await createWritablePrisma();

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

  const totalDisplay = await prisma.sapoOrder.count();
  log(
    JSON.stringify({
      mode: 'from-display',
      totalDisplay,
      existingCrm: existingOrders.size,
      customers: customerBySapo.size,
      variantsBySapo: variantBySapo.size,
    }),
  );

  let scanned = 0;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  let items = 0;
  let cursor = 0n;

  for (;;) {
    await ensureWritable(prisma);
    // Only pull display orders not yet in CRM (anti-join) — skip phase is free.
    const idRows = await prisma.$queryRaw`
      SELECT so.id
      FROM sapo_orders so
      WHERE so.id > ${cursor}
        AND NOT EXISTS (
          SELECT 1 FROM orders o WHERE o.sapo_id = so.sapo_id
        )
      ORDER BY so.id ASC
      LIMIT ${PAGE}
    `;
    if (!idRows.length) break;
    const ids = idRows.map((r) => r.id);
    cursor = ids[ids.length - 1];

    const page = await prisma.sapoOrder.findMany({
      where: { id: { in: ids } },
      orderBy: { id: 'asc' },
      include: { items: true },
    });
    scanned += page.length;
    const pending = page.filter((o) => {
      const sapoId = Number(o.sapoId);
      if (existingOrders.has(sapoId)) {
        skipped++;
        return false;
      }
      return true;
    });

    for (let i = 0; i < pending.length; i += ORDER_BATCH) {
      const chunk = pending.slice(i, i + ORDER_BATCH);
      const orderRows = [];
      const itemsBySapo = new Map();

      for (const o of chunk) {
        const sapoId = Number(o.sapoId);
        const customerSapoId = o.customerSapoId
          ? Number(o.customerSapoId)
          : null;
        const customerId = customerSapoId
          ? customerBySapo.get(customerSapoId) ?? null
          : null;
        const paymentStatus = mapPayment(o.financialStatus);
        const totalAmount = dec(o.totalPrice);
        const paidAmount =
          paymentStatus === 'da_thanh_toan'
            ? totalAmount
            : paymentStatus === 'mot_phan'
              ? totalAmount.div(2)
              : new Prisma.Decimal(0);

        // Unique code: prefer Sapo name, fall back to id (batch-safe).
        const code = `${orderCode(o.code, sapoId)}`.slice(0, 100);

        orderRows.push({
          sapoId: BigInt(sapoId),
          customerId,
          branchId: branch.id,
          source: 'sapo',
          status: mapStatus(o),
          createdById: user.id,
          email: o.email || null,
          phone: o.phone || null,
          subtotal: dec(o.subtotalPrice || o.totalLineItemsPrice),
          discountTotal: dec(o.totalDiscounts),
          taxTotal: dec(o.totalTax),
          shippingFee: dec(o.totalShippingPrice),
          totalAmount,
          totalQuantity: o.itemQuantity || 0,
          paymentStatus,
          paidAmount,
          note: o.note || null,
          tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
          orderedAt: o.createdOn || new Date(),
          code,
        });

        const itemCreates = [];
        for (const li of o.items || []) {
          let variantId = null;
          if (li.variantSapoId && variantBySapo.has(Number(li.variantSapoId))) {
            variantId = variantBySapo.get(Number(li.variantSapoId));
          } else if (li.sku && variantBySku.has(String(li.sku).trim())) {
            variantId = variantBySku.get(String(li.sku).trim());
          } else if (
            li.variantSapoId &&
            variantBySku.has(`SAPO-V-${li.variantSapoId}`)
          ) {
            variantId = variantBySku.get(`SAPO-V-${li.variantSapoId}`);
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
              (li.sku || `SAPO-V-${li.variantSapoId || li.sapoLineItemId || 0}`).trim() ||
              'SAPO-UNKNOWN',
            quantity: qty,
            price,
            discount: dec(li.totalDiscount),
            total: price.mul(qty),
          });
        }
        itemsBySapo.set(sapoId, itemCreates);
      }

      try {
        // Prefer unique code = SAPO-{id} for batch to avoid name collisions.
        const batchData = orderRows.map((r) => ({
          ...r,
          code: `SAPO-${r.sapoId}`.slice(0, 100),
        }));
        const created = await prisma.order.createManyAndReturn({
          data: batchData,
          skipDuplicates: true,
        });
        const idBySapo = new Map(
          created.map((o) => [Number(o.sapoId), o.id]),
        );
        const itemRows = [];
        for (const r of orderRows) {
          const sapoId = Number(r.sapoId);
          const orderId = idBySapo.get(sapoId);
          if (!orderId) {
            existingOrders.add(sapoId);
            skipped++;
            continue;
          }
          existingOrders.add(sapoId);
          inserted++;
          for (const it of itemsBySapo.get(sapoId) || []) {
            itemRows.push({ ...it, orderId });
          }
        }
        if (itemRows.length) {
          await prisma.orderItem.createMany({ data: itemRows });
          items += itemRows.length;
        }
      } catch (e) {
        for (const r of orderRows) {
          const sapoId = Number(r.sapoId);
          if (existingOrders.has(sapoId)) {
            skipped++;
            continue;
          }
          try {
            const itemCreates = itemsBySapo.get(sapoId) || [];
            await prisma.order.create({
              data: {
                ...r,
                code: `SAPO-${sapoId}`.slice(0, 100),
                ...(itemCreates.length
                  ? { items: { create: itemCreates } }
                  : {}),
              },
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
        }
      }
    }

    log(
      JSON.stringify({
        cursor: String(cursor),
        scanned,
        inserted,
        skipped,
        failed,
        items,
        remainingApprox: Math.max(0, totalDisplay - existingOrders.size),
      }),
    );
  }

  const dbCount = await prisma.order.count({ where: { sapoId: { not: null } } });
  log(
    JSON.stringify({
      done: true,
      scanned,
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

process.on('uncaughtException', (e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED', e);
  process.exit(1);
});
process.on('SIGTERM', () => {
  console.error('SIGTERM');
  process.exit(143);
});
process.on('SIGHUP', () => {
  console.error('SIGHUP');
});
process.on('exit', (code) => {
  try {
    require('fs').appendFileSync(
      '/tmp/sapo-orders-crm-exit.log',
      `exit ${code} ${new Date().toISOString()}\n`,
    );
  } catch (_) {}
});
