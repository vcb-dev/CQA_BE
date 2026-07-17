/**
 * Import sản phẩm từ Sapo Private App → bảng products / product_variants.
 * Chạy: node scripts/import-sapo-products.js
 */
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const CONCURRENCY = Math.max(2, Math.min(6, Number(process.env.SAPO_IMPORT_CONCURRENCY || 3)));
const SKIP_INVENTORY = ['1', 'true', 'yes'].includes(
  String(process.env.SAPO_SKIP_INVENTORY || '1').toLowerCase(),
);
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
  if (!key || !secret) throw new Error('Thiếu SAPO_API_KEY / SAPO_API_SECRET');
  return { auth: { username: key, password: secret }, headers: { 'Content-Type': 'application/json' } };
}

function parseTags(tags) {
  if (!tags?.trim()) return [];
  return tags.split(',').map((t) => t.trim()).filter(Boolean);
}

function parseProductType(raw) {
  const value = (raw || '').trim();
  if (!value) return { category: null, material: null };
  const parts = value.split('>>').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { category: null, material: null };
  if (parts.length === 1) return { category: parts[0], material: null };
  return { category: parts[0], material: parts.slice(1).join(' >> ') };
}

const UNIT_CANONICAL = {
  chiec: 'Chiếc', cai: 'Cái', doi: 'Đôi', cap: 'Cặp', vien: 'Viên',
  day: 'Dây', set: 'Set', bo: 'Bộ', chuoi: 'Chuỗi', hop: 'Hộp',
};

function normalizeUnit(raw) {
  const value = (raw || '').trim();
  if (!value || /\d/.test(value)) return null;
  const key = value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z]/g, '');
  if (!key) return null;
  return UNIT_CANONICAL[key] || value.charAt(0).toUpperCase() + value.slice(1);
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const CRAFT_TYPE_MAP = { 'che tac': 'Chế tác', 'thiet ke': 'Thiết kế', mau: 'Mẫu' };

function markerKey(value) {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

function extractNameMarkers(rawName) {
  let name = (rawName || '').replace(/^[\s\p{M}]+/u, '').trim();
  let craftType = null;
  let isDiscontinued = false;
  const leading = /^[\s\p{M}]*\(([^)]*)\)\s*[-–:]?\s*/u;
  for (let guard = 0; guard < 5; guard++) {
    const m = name.match(leading);
    if (!m) break;
    const key = markerKey(m[1]);
    if (CRAFT_TYPE_MAP[key]) {
      craftType = craftType || CRAFT_TYPE_MAP[key];
      name = name.slice(m[0].length).trim();
      continue;
    }
    if (key.startsWith('dung')) {
      isDiscontinued = true;
      name = name.slice(m[0].length).trim();
      continue;
    }
    break;
  }
  name = name.replace(/^[\s\p{M}]+/u, '').trim();
  return { name: name || (rawName || '').trim(), craftType, isDiscontinued };
}

function slugify(name, id) {
  const base = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  return base || `san-pham-${id}`;
}

function resolveSlug(p) {
  const alias = (p.alias || '').trim().toLowerCase();
  if (alias) return alias.slice(0, 200);
  return slugify((p.name || p.title || '').trim(), p.id);
}

function resolveSku(v) {
  const s = (v.sku || '').trim();
  return s ? s.slice(0, 64) : `SP-${v.id}`;
}

async function ensureUniqueSlug(base, sapoId) {
  const taken = await prisma.product.findUnique({ where: { slug: base }, select: { id: true } });
  if (!taken) return base;
  const suffixed = `${base}-${sapoId}`.slice(0, 200);
  const taken2 = await prisma.product.findUnique({ where: { slug: suffixed }, select: { id: true } });
  if (!taken2) return suffixed;
  return `sp-${sapoId}`.slice(0, 200);
}

async function ensureUniqueSku(base, sapoVariantId) {
  const taken = await prisma.productVariant.findUnique({ where: { sku: base }, select: { id: true } });
  if (!taken) return base;
  return `SP-${sapoVariantId}`.slice(0, 64);
}

async function fetchAllProducts() {
  const host = storeHost();
  const url = `https://${host}/admin/products.json`;
  const cfg = apiAuth();
  const all = [];
  for (let page = 1; page <= 80; page++) {
    const { data } = await axios.get(url, { ...cfg, params: { limit: 250, page }, timeout: 60_000 });
    const batch = data.products || [];
    if (!batch.length) break;
    all.push(...batch);
    console.log(`Fetched page ${page}: ${batch.length} products (total ${all.length})`);
    if (batch.length < 250) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return all;
}

async function upsertOneProduct(raw, warehouse) {
  const sapoId = raw.id;
  const rawName = (raw.name || raw.title || '').trim();
  if (!sapoId || !rawName) return { products: 0, variants: 0, error: null };
  const { name, craftType, isDiscontinued } = extractNameMarkers(rawName);

  const slug = await ensureUniqueSlug(resolveSlug(raw), sapoId);
  const tags = parseTags(raw.tags);
  const primaryImage = raw.image?.src || raw.images?.[0]?.src || null;
  const isPublished = (raw.status || 'active').toLowerCase() === 'active';
  const { category, material } = parseProductType(raw.product_type);
  const unit = normalizeUnit(raw.variants?.[0]?.unit);
  const productTypeRaw = raw.product_type?.trim() || null;
  const shortDescription = (raw.summary || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50000) || null;
  const seoTitle = raw.meta_title?.trim() || null;
  const seoDescription = raw.meta_description?.trim() || null;
  const taxIndustryGroup = raw.vat_pit_category_code?.trim() || null;
  const publishedAt = parseDate(raw.published_on);
  const sapoCreatedAt = parseDate(raw.created_on);
  const sapoUpdatedAt = parseDate(raw.modified_on);

  const productCreate = {
    sapoId: BigInt(sapoId),
    name,
    brand: raw.vendor?.trim() || null,
    category,
    material,
    craftType,
    isDiscontinued,
    productType: productTypeRaw,
    unit,
    tags,
    isPublished,
    imageUrl: primaryImage,
    description: (raw.content || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 50000) || null,
    shortDescription,
    seoTitle,
    seoDescription,
    taxIndustryGroup,
    publishedAt,
    sapoCreatedAt,
    sapoUpdatedAt,
    salesChannels: { create: [{ channel: 'sapo' }] },
  };
  const productUpdate = {
    sapoId: BigInt(sapoId),
    name,
    brand: raw.vendor?.trim() || null,
    category,
    material,
    craftType,
    isDiscontinued,
    productType: productTypeRaw,
    unit,
    tags,
    isPublished,
    imageUrl: primaryImage,
    shortDescription,
    seoTitle,
    seoDescription,
    taxIndustryGroup,
    publishedAt,
    sapoCreatedAt,
    sapoUpdatedAt,
  };

  let product;
  try {
    product = await prisma.product.upsert({
      where: { slug },
      create: { slug, ...productCreate },
      update: productUpdate,
    });
  } catch (e) {
    if (e?.code === 'P2002') {
      const fallbackSlug = `sp-${sapoId}`.slice(0, 200);
      product = await prisma.product.upsert({
        where: { slug: fallbackSlug },
        create: { slug: fallbackSlug, ...productCreate },
        update: productUpdate,
      });
    } else {
      throw e;
    }
  }

  await prisma.productSalesChannel.upsert({
    where: { productId_channel: { productId: product.id, channel: 'sapo' } },
    create: { productId: product.id, channel: 'sapo' },
    update: {},
  });

  let variantCount = 0;
  for (const v of raw.variants || []) {
    if (!v.id) continue;
    const sku = await ensureUniqueSku(resolveSku(v), v.id);
    const price = String(v.price ?? '0');
    const qty = typeof v.inventory_quantity === 'number' ? v.inventory_quantity : 0;
    const variantTitle = (v.title || v.option1 || 'Default').trim() || 'Default';

    const variant = await prisma.productVariant.upsert({
      where: { sku },
      create: {
        productId: product.id,
        sku,
        title: variantTitle,
        barcode: v.barcode?.trim() || null,
        price,
        compareAtPrice: v.compare_at_price != null ? String(v.compare_at_price) : null,
        unit: normalizeUnit(v.unit),
        imageUrl: primaryImage,
        enabled: isPublished,
      },
      update: {
        productId: product.id,
        title: variantTitle,
        price,
        compareAtPrice: v.compare_at_price != null ? String(v.compare_at_price) : null,
        unit: normalizeUnit(v.unit),
        enabled: isPublished,
      },
    });
    variantCount++;

    if (warehouse && !SKIP_INVENTORY) {
      await prisma.inventoryLevel.upsert({
        where: { variantId_warehouseId: { variantId: variant.id, warehouseId: warehouse.id } },
        create: {
          variantId: variant.id,
          warehouseId: warehouse.id,
          onHand: qty,
          available: qty,
          price,
        },
        update: { onHand: qty, available: qty, price },
      });
    }
  }

  return { products: 1, variants: variantCount, error: null };
}

async function runPool(items, worker, concurrency) {
  let index = 0;
  const results = [];

  async function next() {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => next()));
  return results;
}

async function main() {
  console.log(`Sapo → products import (concurrency=${CONCURRENCY}, skipInventory=${SKIP_INVENTORY})`);
  console.log(`Endpoint: GET https://${storeHost()}/admin/products.json`);

  const warehouse = await prisma.warehouse.findFirst({ where: { isActive: true }, orderBy: { id: 'asc' } });
  if (!warehouse) console.warn('Chưa có kho — bỏ qua inventory_levels');

  const products = await fetchAllProducts();
  console.log(`\n✓ Đã tải ${products.length} sản phẩm từ Sapo — bắt đầu lưu DB...`);

  let productsSaved = 0;
  let variantsUpserted = 0;
  let processed = 0;
  let errors = 0;
  const startedAt = Date.now();

  await runPool(
    products,
    async (raw) => {
      try {
        const result = await upsertOneProduct(raw, warehouse);
        productsSaved += result.products;
        variantsUpserted += result.variants;
      } catch (e) {
        errors++;
        if (errors <= 10) {
          console.warn(`  ⚠ Lỗi SP #${raw?.id}: ${e.message || e}`);
        }
      }
      processed++;
      if (processed % 100 === 0 || processed === products.length) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
        const rate = (processed / Math.max(1, elapsed)).toFixed(1);
        console.log(
          `  Lưu DB: ${processed}/${products.length} SP · ${variantsUpserted} variants · ${errors} lỗi · ${rate}/s · ${elapsed}s`,
        );
      }
    },
    CONCURRENCY,
  );

  const finalProducts = await prisma.product.count();
  const finalVariants = await prisma.productVariant.count();
  console.log(
    `\nDone: ${productsSaved} products processed, ${variantsUpserted} variants upserted, ${errors} errors`,
  );
  console.log(`DB hiện có: ${finalProducts} products, ${finalVariants} variants`);
}

main()
  .catch((e) => {
    console.error(e.response?.data || e.message || e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
