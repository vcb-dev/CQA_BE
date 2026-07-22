/**
 * Sync Sapo products → products / variants / inventory (standalone).
 * Usage: node scripts/sapo-sync-products-standalone.js
 */
const { Prisma } = require('@prisma/client');
const {
  log,
  createWritablePrisma,
  ensureWritable,
  sapoAuth,
  sapoHost,
  errInfo,
  fetchSapoListPages,
} = require('./lib/sapo-sync-common');

function stripHtml(html) {
  if (!html) return null;
  const t = String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t.slice(0, 20000) : null;
}

async function main() {
  const prisma = await createWritablePrisma();
  const host = sapoHost();
  const auth = sapoAuth();

  const warehouse = await prisma.warehouse.findFirst({
    where: { isActive: true },
    orderBy: { id: 'asc' },
  });
  const warehouseId = warehouse?.id ?? null;

  const existing = new Set(
    (
      await prisma.product.findMany({
        where: { sapoId: { not: null } },
        select: { sapoId: true },
      })
    ).map((r) => Number(r.sapoId)),
  );

  log(
    JSON.stringify({
      host,
      existing: existing.size,
      warehouseId: warehouseId?.toString() ?? null,
    }),
  );

  let fetched = 0;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  await fetchSapoListPages({
    host,
    auth,
    path: '/admin/products.json',
    rootKey: 'products',
    delayMs: 80,
    onPage: async ({ batch, page }) => {
      await ensureWritable(prisma);
      fetched += batch.length;

      for (const raw of batch) {
        const sapoId = raw.id;
        if (!sapoId) continue;
        if (existing.has(sapoId)) {
          skipped++;
          continue;
        }

        const name = (raw.name || raw.title || '').trim();
        if (!name) {
          skipped++;
          continue;
        }

        const isPublished = (raw.status || 'active').toLowerCase() === 'active';
        const primaryImage = raw.image?.src || raw.images?.[0]?.src || null;
        const variants = (raw.variants || [])
          .filter((v) => v.id)
          .map((v) => {
            const price = new Prisma.Decimal(String(v.price ?? '0'));
            const qty =
              typeof v.inventory_quantity === 'number' ? v.inventory_quantity : 0;
            return {
              sapoId: BigInt(v.id),
              sku: `SAPO-V-${v.id}`,
              title: v.title || v.name || null,
              barcode: v.barcode || null,
              price,
              enabled: isPublished,
              ...(warehouseId
                ? {
                    inventoryLevels: {
                      create: [
                        {
                          warehouseId,
                          onHand: qty,
                          available: qty,
                          price,
                        },
                      ],
                    },
                  }
                : {}),
            };
          });

        const images = (raw.images || [])
          .filter((img) => img.src)
          .slice(0, 20)
          .map((img, idx) => ({
            url: img.src,
            position: img.position ?? idx,
            isPrimary: idx === 0,
          }));
        if (!images.length && primaryImage) {
          images.push({ url: primaryImage, position: 0, isPrimary: true });
        }

        try {
          await prisma.product.create({
            data: {
              sapoId: BigInt(sapoId),
              slug: `sapo-${sapoId}`,
              name,
              brand: raw.vendor || null,
              productType: raw.product_type || null,
              isPublished,
              imageUrl: primaryImage,
              description: stripHtml(raw.content),
              shortDescription: stripHtml(raw.summary),
              trackInventory: true,
              salesChannels: { create: [{ channel: 'sapo' }] },
              ...(images.length ? { images: { create: images } } : {}),
              ...(variants.length ? { variants: { create: variants } } : {}),
            },
          });
          existing.add(sapoId);
          inserted++;
          if (inserted % 50 === 0) {
            log(
              JSON.stringify({ page, fetched, inserted, skipped, failed }),
            );
          }
        } catch (e) {
          // Unique race / already inserted — treat as skip, not fatal known.
          if (e.code === 'P2002') {
            existing.add(sapoId);
            skipped++;
          } else {
            failed++;
            if (failed <= 30 || failed % 50 === 0) {
              log(JSON.stringify({ fail: sapoId, ...errInfo(e) }));
            }
            if (
              String(e.message || '').includes('read-only') ||
              errInfo(e).pg?.includes('read-only')
            ) {
              await ensureWritable(prisma);
            }
          }
        }
      }

      log(
        JSON.stringify({
          pageDone: page,
          batch: batch.length,
          fetched,
          inserted,
          skipped,
          failed,
          known: existing.size,
        }),
      );
    },
  });

  const dbCount = await prisma.product.count({ where: { sapoId: { not: null } } });
  log(
    JSON.stringify({
      done: true,
      fetched,
      inserted,
      skipped,
      failed,
      productsWithSapoDb: dbCount,
    }),
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
