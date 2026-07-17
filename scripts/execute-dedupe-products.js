const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = new PrismaClient();

async function tableExists(name) {
  const r = await prisma.$queryRawUnsafe(
    `SELECT to_regclass('public.${name}')::text AS t`,
  );
  return r[0].t != null;
}

async function main() {
  const idFile = path.join(__dirname, 'out', 'dedupe-delete-ids.json');
  const ids = JSON.parse(fs.readFileSync(idFile, 'utf8')).map((x) => BigInt(x));
  if (!ids.length) { console.log('Không có gì để xóa.'); return; }
  const idList = ids.map((x) => x.toString()).join(',');
  const variantSub = `SELECT id FROM product_variants WHERE product_id IN (${idList})`;

  // Sao lưu
  const backup = await prisma.$queryRawUnsafe(`
    SELECT p.id AS product_id, p.name, p.sapo_id::text AS sapo_id,
           v.id AS variant_id, v.sku, v.price::text AS price
    FROM products p LEFT JOIN product_variants v ON v.product_id = p.id
    WHERE p.id IN (${idList})`);
  const backupFile = path.join(__dirname, 'out', `dedupe-backup-${Date.now()}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(backup.map((r) => ({
    ...r, product_id: r.product_id.toString(), variant_id: r.variant_id?.toString() ?? null,
  })), null, 2));
  console.log(`Sao lưu ${backup.length} dòng -> ${path.basename(backupFile)}`);

  // Chỉ dựng lệnh DELETE cho bảng thực sự tồn tại — theo đúng thứ tự FK
  const plan = [
    { table: 'inventory_levels', sql: `DELETE FROM inventory_levels WHERE variant_id IN (${variantSub})` },
    { table: 'sapo_inbox_order_items', sql: `DELETE FROM sapo_inbox_order_items WHERE variant_id IN (${variantSub})` },
    { table: 'variant_option_values', sql: `DELETE FROM variant_option_values WHERE variant_id IN (${variantSub})` },
    { table: 'product_variants', sql: `DELETE FROM product_variants WHERE product_id IN (${idList})` },
    { table: 'product_images', sql: `DELETE FROM product_images WHERE product_id IN (${idList})` },
    { table: 'product_sales_channels', sql: `DELETE FROM product_sales_channels WHERE product_id IN (${idList})` },
    { table: 'product_options', sql: `DELETE FROM product_options WHERE product_id IN (${idList})` },
    { table: 'product_categories', sql: `DELETE FROM product_categories WHERE product_id IN (${idList})` },
    { table: 'products', sql: `DELETE FROM products WHERE id IN (${idList})` },
  ];
  const active = [];
  for (const step of plan) {
    if (await tableExists(step.table)) active.push(step);
  }

  const before = (await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM products`))[0].n;

  const counts = await prisma.$transaction(async (tx) => {
    const out = {};
    for (const step of active) {
      out[step.table] = await tx.$executeRawUnsafe(step.sql);
    }
    return out;
  });

  const after = (await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM products`))[0].n;
  const vAfter = (await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM product_variants`))[0].n;

  console.log('Đã xóa theo bảng:', counts);
  console.log(`Products: ${before} -> ${after} | Variants còn: ${vAfter}`);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); }).finally(() => prisma.$disconnect());
