/**
 * Đọc lại sản phẩm từ Sapo và cập nhật size/màu (product_variants.title)
 * cho các biến thể KHỚP THEO SKU trong DB. KHÔNG tạo/xóa sản phẩm.
 * Chạy: node scripts/enrich-variant-size.js
 */
const path = require('path');
const axios = require('axios');
const { PrismaClient, Prisma } = require('@prisma/client');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = new PrismaClient();

function storeHost() {
  const raw = (process.env.SAPO_STORE || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('Thiếu SAPO_STORE');
  return raw.includes('mysapo.net') ? raw.replace(/^https?:\/\//, '') : `${raw}.mysapo.net`;
}
function apiAuth() {
  const token = (process.env.SAPO_ACCESS_TOKEN || '').trim();
  if (token) return { headers: { 'Content-Type': 'application/json', 'X-Sapo-Access-Token': token } };
  const key = (process.env.SAPO_PRIVATE_API_KEY || process.env.SAPO_API_KEY || '').trim();
  const secret = (process.env.SAPO_PRIVATE_API_SECRET || process.env.SAPO_API_SECRET || '').trim();
  if (!key || !secret) throw new Error('Thiếu SAPO_API_KEY / SAPO_API_SECRET');
  return { auth: { username: key, password: secret }, headers: { 'Content-Type': 'application/json' } };
}

const isDefault = (s) => !s || /^default(\s+title)?$/i.test(s.trim());

/** Size/màu người đọc được: ưu tiên variant.title, fallback option1/2/3. */
function sizeColor(v) {
  const t = (v.title || '').trim();
  if (t && !isDefault(t)) return t.slice(0, 200);
  const parts = [v.option1, v.option2, v.option3]
    .map((x) => (x || '').trim())
    .filter((x) => x && !isDefault(x));
  return parts.length ? parts.join(' / ').slice(0, 200) : null;
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
    if (page % 5 === 0) console.log(`  ...fetched ${all.length} SP`);
    if (batch.length < 250) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return all;
}

async function main() {
  console.log(`Đọc Sapo: GET https://${storeHost()}/admin/products.json`);
  const products = await fetchAllProducts();
  console.log(`✓ Tải ${products.length} SP từ Sapo\n`);

  // Map SKU -> size/màu (chỉ giữ những cái có giá trị thật)
  const skuToSize = new Map();
  let sapoVariants = 0;
  for (const p of products) {
    for (const v of p.variants || []) {
      sapoVariants++;
      const sku = (v.sku || '').trim();
      if (!sku) continue;
      const sc = sizeColor(v);
      if (sc) skuToSize.set(sku.slice(0, 64), sc);
    }
  }
  console.log(`Sapo có ${sapoVariants} variants · ${skuToSize.size} SKU có size/màu\n`);

  // Chỉ cập nhật những variant tồn tại trong DB
  const dbSkus = await prisma.productVariant.findMany({ select: { sku: true } });
  const dbSet = new Set(dbSkus.map((r) => r.sku));
  const updates = [];
  for (const [sku, sc] of skuToSize) if (dbSet.has(sku)) updates.push([sku, sc]);
  console.log(`DB có ${dbSet.size} variants · sẽ cập nhật size/màu cho ${updates.length} variant\n`);

  let done = 0;
  const chunk = 500;
  for (let i = 0; i < updates.length; i += chunk) {
    const slice = updates.slice(i, i + chunk);
    const values = Prisma.join(slice.map(([sku, sc]) => Prisma.sql`(${sku}, ${sc})`));
    await prisma.$executeRaw`
      UPDATE product_variants AS v
      SET title = data.title
      FROM (VALUES ${values}) AS data(sku, title)
      WHERE v.sku = data.sku`;
    done += slice.length;
    console.log(`  cập nhật ${done}/${updates.length}`);
  }

  const [{ n }] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM product_variants WHERE title IS NOT NULL AND title !~* '^default' AND btrim(title)<>''`,
  );
  console.log(`\n✓ Xong. Variant có size/màu trong DB: ${n}`);

  const sample = await prisma.$queryRawUnsafe(
    `SELECT pr.name, v.sku, v.title FROM product_variants v JOIN products pr ON pr.id=v.product_id
     WHERE v.title IS NOT NULL AND v.title !~* '^default' ORDER BY random() LIMIT 8`,
  );
  console.log('\nVí dụ:');
  for (const s of sample) console.log(`  "${s.name}" | sku=${s.sku} | size/màu="${s.title}"`);
}
main().catch((e) => { console.error(e.response?.data || e.message || e); process.exit(1); })
  .finally(() => prisma.$disconnect());
