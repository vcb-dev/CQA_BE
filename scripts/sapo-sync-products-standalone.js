/**
 * Sync Sapo products → DB (standalone, không Nest — nhanh hơn).
 * Usage: node scripts/sapo-sync-products-standalone.js
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

function stripHtml(html) {
  if (!html) return null;
  const t = String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t.slice(0, 20000) : null;
}

function hostOf(store) {
  const s = (store || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return s.includes('mysapo.net') ? s : `${s}.mysapo.net`;
}

async function main() {
  const prisma = new PrismaClient();
  const host = hostOf(process.env.SAPO_STORE);
  const auth = {
    username: process.env.SAPO_API_KEY || process.env.SAPO_PRIVATE_API_KEY,
    password: process.env.SAPO_API_SECRET || process.env.SAPO_PRIVATE_API_SECRET,
  };
  if (!host || !auth.username || !auth.password) {
    throw new Error('Missing SAPO_STORE / SAPO_API_KEY / SAPO_API_SECRET');
  }

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
  console.log(
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

  for (let page = 1; page <= 500; page++) {
    const { data } = await axios.get(`https://${host}/admin/products.json`, {
      auth,
      params: { limit: 250, page },
      timeout: 90_000,
    });
    const batch = data.products || [];
    if (!batch.length) break;
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
          const qty = typeof v.inventory_quantity === 'number' ? v.inventory_quantity : 0;
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
          console.log(
            JSON.stringify({
              page,
              fetched,
              inserted,
              skipped,
              failed,
              known: existing.size,
            }),
          );
        }
      } catch (e) {
        failed++;
        existing.add(sapoId);
        if (failed <= 20 || failed % 50 === 0) {
          console.log(
            JSON.stringify({
              fail: sapoId,
              code: e.code || null,
              message: e.message?.slice(0, 120),
            }),
          );
        }
      }
    }

    console.log(
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
    if (batch.length < 250) break;
    await new Promise((r) => setTimeout(r, 80));
  }

  console.log(
    JSON.stringify({
      done: true,
      fetched,
      inserted,
      skipped,
      failed,
      productsWithSapo: existing.size,
    }),
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
