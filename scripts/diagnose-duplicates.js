const path = require('path');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = new PrismaClient();

async function q(sql) {
  return prisma.$queryRawUnsafe(sql);
}

async function main() {
  const [{ p }] = await q('SELECT COUNT(*)::int AS p FROM products');
  const [{ v }] = await q('SELECT COUNT(*)::int AS v FROM product_variants');
  console.log(`Tổng products: ${p} | product_variants: ${v}\n`);

  // 1) SKU placeholder vs thật
  const [{ ph }] = await q(`SELECT COUNT(*)::int AS ph FROM product_variants WHERE sku LIKE 'SP-%'`);
  console.log(`Variant SKU placeholder (SP-...): ${ph}`);
  const [{ zero }] = await q(`SELECT COUNT(*)::int AS zero FROM product_variants WHERE price = 0`);
  console.log(`Variant giá = 0: ${zero}\n`);

  // 2) Products trùng theo sapo_id
  const dupSapo = await q(`
    SELECT sapo_id, COUNT(*)::int AS n FROM products
    WHERE sapo_id IS NOT NULL GROUP BY sapo_id HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 10`);
  console.log(`Nhóm products trùng sapo_id: ${dupSapo.length}`);

  // 3) Products trùng theo name (chuẩn hóa lower/trim)
  const dupName = await q(`
    SELECT lower(btrim(name)) AS key, COUNT(*)::int AS n
    FROM products GROUP BY lower(btrim(name)) HAVING COUNT(*) > 1 ORDER BY n DESC`);
  const dupNameProducts = dupName.reduce((s, r) => s + r.n, 0);
  console.log(`Nhóm products trùng TÊN: ${dupName.length} (gồm ${dupNameProducts} product rows)`);
  console.log('  Ví dụ:');
  for (const r of dupName.slice(0, 8)) console.log(`   x${r.n}  ${r.key}`);

  // 4) Variants trùng trong cùng 1 product (product_id + title)
  const dupVar = await q(`
    SELECT product_id, COALESCE(title,'') AS title, COUNT(*)::int AS n
    FROM product_variants GROUP BY product_id, COALESCE(title,'')
    HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 10`);
  console.log(`\nNhóm variant trùng trong cùng product (product_id+title): ${dupVar.length}`);

  // 5) Chi tiết 1 cặp trùng tên để hiểu pattern
  if (dupName.length) {
    const key = dupName[0].key;
    const rows = await q(`
      SELECT p.id AS product_id, p.sapo_id, p.name, p.is_published, p.is_discontinued,
             v.id AS variant_id, v.sku, v.price::text AS price, v.title, v.enabled
      FROM products p
      LEFT JOIN product_variants v ON v.product_id = p.id
      WHERE lower(btrim(p.name)) = '${key.replace(/'/g, "''")}'
      ORDER BY p.id, v.id`);
    console.log(`\n--- Chi tiết nhóm "${key}" ---`);
    for (const r of rows) {
      console.log(`  prod#${r.product_id} sapo=${r.sapo_id ?? '-'} pub=${r.is_published} disc=${r.is_discontinued} | var#${r.variant_id} sku=${r.sku} price=${r.price} enabled=${r.enabled} title=${r.title ?? '-'}`);
    }
  }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); }).finally(() => prisma.$disconnect());
