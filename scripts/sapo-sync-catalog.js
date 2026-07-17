/**
 * Đồng bộ catalog từ Sapo Private App → bảng sapo_catalog_variants.
 * Chạy: node scripts/sapo-sync-catalog.js
 */
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

function storeHost() {
  const raw = (process.env.SAPO_STORE || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('Thiếu SAPO_STORE');
  return raw.includes('mysapo.net') ? raw.replace(/^https?:\/\//, '') : `${raw}.mysapo.net`;
}

function apiAuth() {
  const token = (process.env.SAPO_ACCESS_TOKEN || '').trim();
  if (token) {
    return { headers: { 'Content-Type': 'application/json', 'X-Sapo-Access-Token': token } };
  }
  const key = (process.env.SAPO_PRIVATE_API_KEY || process.env.SAPO_API_KEY || '').trim();
  const secret = (process.env.SAPO_PRIVATE_API_SECRET || process.env.SAPO_API_SECRET || '').trim();
  if (!key || !secret) throw new Error('Thiếu SAPO_API_KEY / SAPO_API_SECRET hoặc SAPO_ACCESS_TOKEN');
  return { auth: { username: key, password: secret }, headers: { 'Content-Type': 'application/json' } };
}

async function fetchAllProducts() {
  const host = storeHost();
  const baseUrl = `https://${host}/admin/products.json`;
  const cfg = apiAuth();
  const items = [];

  for (let page = 1; page <= 50; page++) {
    const { data } = await axios.get(baseUrl, {
      ...cfg,
      params: { limit: 250, page },
      timeout: 60_000,
    });
    const products = data.products || [];
    if (!products.length) break;

    for (const p of products) {
      const productId = p.id;
      const productTitle = (p.name || p.title || '').trim();
      const tags = (p.tags || '').trim();
      const images = p.images || [];
      const imageById = new Map(images.filter((i) => i.id).map((i) => [i.id, i.src || null]));
      const fallbackImage = p.image?.src || images[0]?.src || null;

      for (const v of p.variants || []) {
        if (!productId || !v.id) continue;
        const imageUrl = v.image_id != null ? imageById.get(v.image_id) || fallbackImage : fallbackImage;
        items.push({
          sapoProductId: productId,
          sapoVariantId: v.id,
          productTitle,
          variantTitle: (v.title || v.option1 || 'Default').trim(),
          price: String(v.price ?? '0'),
          compareAtPrice: v.compare_at_price != null ? String(v.compare_at_price) : null,
          sku: v.sku || null,
          tags,
          imageUrl,
          inventoryQty: typeof v.inventory_quantity === 'number' ? v.inventory_quantity : 0,
        });
      }
    }

    console.log(`Page ${page}: +${products.length} products (total variants: ${items.length})`);
    if (products.length < 250) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  return items;
}

async function main() {
  console.log(`Sapo host: ${storeHost()}`);
  console.log('Endpoint: GET /admin/products.json');
  const items = await fetchAllProducts();
  if (!items.length) {
    console.error('Không lấy được variant nào từ Sapo.');
    process.exit(1);
  }

  let upserted = 0;
  const batchSize = 100;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await prisma.$transaction(
      batch.map((item) =>
        prisma.sapoCatalogVariant.upsert({
          where: { sapoVariantId: item.sapoVariantId },
          create: { ...item, isActive: true },
          update: { ...item, isActive: true },
        }),
      ),
    );
    upserted += batch.length;
    if (upserted % 500 === 0 || upserted === items.length) {
      console.log(`Upserted ${upserted}/${items.length}...`);
    }
  }

  const variantIds = items.map((i) => i.sapoVariantId);
  const deactivated = await prisma.sapoCatalogVariant.updateMany({
    where: { isActive: true, sapoVariantId: { notIn: variantIds } },
    data: { isActive: false },
  });

  console.log(`Done: upserted=${upserted}, deactivated=${deactivated.count}`);
}

main()
  .catch((e) => {
    console.error(e.response?.data || e.message || e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
