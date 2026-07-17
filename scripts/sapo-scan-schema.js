/**
 * Quét dữ liệu Sapo (không ghi DB) để phân tích cấu trúc field trước khi tái cấu trúc bảng products.
 * Chạy: node scripts/sapo-scan-schema.js
 * Xuất: scripts/out/sapo-scan-report.json + in tóm tắt ra console.
 */
const path = require('path');
const fs = require('fs');
const axios = require('axios');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

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

const MAX_PAGES = Number(process.env.SCAN_MAX_PAGES || 80);

async function fetchAll() {
  const host = storeHost();
  const url = `https://${host}/admin/products.json`;
  const cfg = apiAuth();
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await axios.get(url, { ...cfg, params: { limit: 250, page }, timeout: 60_000 });
    const batch = data.products || [];
    if (!batch.length) break;
    all.push(...batch);
    process.stdout.write(`\rFetched page ${page}: total ${all.length} products   `);
    if (batch.length < 250) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  process.stdout.write('\n');
  return all;
}

function bump(map, key) {
  if (key == null || key === '') key = '(empty)';
  map.set(key, (map.get(key) || 0) + 1);
}

function topN(map, n = 40) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ value: k, count: v }));
}

function main() {
  return fetchAll().then((products) => {
    const report = {
      scannedAt: new Date().toISOString(),
      store: storeHost(),
      totalProducts: products.length,
    };

    const productKeys = new Map();
    const variantKeys = new Map();
    const productType = new Map();
    const productTypeLevels = new Map();
    const vendor = new Map();
    const status = new Map();
    const optionNames = new Map();
    const optionCounts = new Map();
    const unit = new Map();
    const weightUnit = new Map();
    const tagVocab = new Map();
    let variantsTotal = 0;
    let withCompareAt = 0;
    let withBarcode = 0;
    let withImages = 0;
    let multiVariant = 0;

    for (const p of products) {
      Object.keys(p || {}).forEach((k) => bump(productKeys, k));
      bump(productType, (p.product_type || '').trim());
      const parts = String(p.product_type || '').split('>>').map((s) => s.trim()).filter(Boolean);
      bump(productTypeLevels, String(parts.length));
      bump(vendor, (p.vendor || '').trim());
      bump(status, (p.status || '').trim());
      bump(optionCounts, String((p.options || []).length));
      (p.options || []).forEach((o) => bump(optionNames, (o.name || '').trim()));
      (p.tags ? String(p.tags).split(',') : []).forEach((t) => {
        const tt = t.trim();
        if (tt) bump(tagVocab, tt);
      });
      if ((p.images || []).length) withImages++;
      const variants = p.variants || [];
      if (variants.length > 1) multiVariant++;
      for (const v of variants) {
        variantsTotal++;
        Object.keys(v || {}).forEach((k) => bump(variantKeys, k));
        bump(unit, (v.unit || '').trim());
        bump(weightUnit, (v.weight_unit || '').trim());
        if (v.compare_at_price != null && v.compare_at_price !== '' && Number(v.compare_at_price) > 0) withCompareAt++;
        if (v.barcode && String(v.barcode).trim()) withBarcode++;
      }
    }

    report.summary = {
      variantsTotal,
      productsWithMultipleVariants: multiVariant,
      productsWithImages: withImages,
      variantsWithCompareAt: withCompareAt,
      variantsWithBarcode: withBarcode,
    };
    report.productFieldFrequency = topN(productKeys, 60);
    report.variantFieldFrequency = topN(variantKeys, 60);
    report.productTypeRaw = topN(productType, 80);
    report.productTypeLevelDistribution = topN(productTypeLevels, 10);
    report.vendorDistribution = topN(vendor, 40);
    report.statusDistribution = topN(status, 10);
    report.optionCountDistribution = topN(optionCounts, 10);
    report.optionNames = topN(optionNames, 40);
    report.unitDistribution = topN(unit, 40);
    report.weightUnitDistribution = topN(weightUnit, 10);
    report.tagVocabulary = topN(tagVocab, 120);

    // Lưu vài sản phẩm mẫu nguyên bản để đối chiếu
    report.samples = products.slice(0, 5);

    const outDir = path.join(__dirname, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'sapo-scan-report.json');
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');

    console.log(`\n=== TÓM TẮT QUÉT SAPO (${report.totalProducts} SP, ${variantsTotal} variants) ===`);
    console.log('\n-- product_type theo số cấp (tách bằng ">>") --');
    console.table(report.productTypeLevelDistribution);
    console.log('\n-- Top product_type --');
    console.table(report.productTypeRaw.slice(0, 25));
    console.log('\n-- vendor (brand) --');
    console.table(report.vendorDistribution.slice(0, 15));
    console.log('\n-- option names --');
    console.table(report.optionNames);
    console.log('\n-- option count / SP --');
    console.table(report.optionCountDistribution);
    console.log('\n-- unit --');
    console.table(report.unitDistribution.slice(0, 15));
    console.log('\n-- Field có ở product --');
    console.log(report.productFieldFrequency.map((f) => f.value).join(', '));
    console.log('\n-- Field có ở variant --');
    console.log(report.variantFieldFrequency.map((f) => f.value).join(', '));
    console.log(`\n✓ Báo cáo chi tiết: ${outFile}`);
  });
}

main().catch((e) => {
  console.error('\n❌ Lỗi quét:', e.response?.status, e.response?.data || e.message || e);
  process.exit(1);
});
