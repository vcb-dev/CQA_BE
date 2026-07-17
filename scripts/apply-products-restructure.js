/**
 * Áp dụng tái cấu trúc bảng products lên DB:
 *  - Thêm cột sapo_id, category, material, published_at, sapo_created_at, sapo_updated_at, product_variants.unit
 *  - Tạo index
 *  - Backfill category/material từ product_type cũ + chuẩn hóa unit
 * An toàn để chạy lại (idempotent). Chạy: node scripts/apply-products-restructure.js
 */
const path = require('path');
const { PrismaClient } = require('@prisma/client');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const prisma = new PrismaClient();

const STATEMENTS = [
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS sapo_id BIGINT`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS material TEXT`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS sapo_created_at TIMESTAMPTZ`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS sapo_updated_at TIMESTAMPTZ`,
  `ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS unit TEXT`,
  `ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS title TEXT`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS craft_type TEXT`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS is_discontinued BOOLEAN NOT NULL DEFAULT FALSE`,
  `CREATE UNIQUE INDEX IF NOT EXISTS products_sapo_id_key ON products (sapo_id)`,
  `CREATE INDEX IF NOT EXISTS products_category_material_idx ON products (category, material)`,
  `UPDATE products
     SET category = NULLIF(TRIM(SPLIT_PART(product_type, '>>', 1)), ''),
         material = NULLIF(TRIM(SPLIT_PART(product_type, '>>', 2)), '')
   WHERE product_type IS NOT NULL AND product_type <> ''
     AND category IS NULL AND material IS NULL`,
  `UPDATE products SET unit = CASE
     WHEN unit IS NULL OR TRIM(unit) = '' THEN NULL
     WHEN unit ~ '[0-9]' THEN NULL
     WHEN LOWER(unit) IN ('chiếc','chiec') THEN 'Chiếc'
     WHEN LOWER(unit) IN ('cái','cai') THEN 'Cái'
     WHEN LOWER(unit) IN ('đôi','doi') THEN 'Đôi'
     WHEN LOWER(unit) IN ('cặp','cap') THEN 'Cặp'
     WHEN LOWER(unit) IN ('viên','vien') THEN 'Viên'
     WHEN LOWER(unit) = 'dây' THEN 'Dây'
     WHEN LOWER(unit) = 'set' THEN 'Set'
     WHEN LOWER(unit) IN ('bộ','bo') THEN 'Bộ'
     WHEN LOWER(unit) IN ('chuỗi','chuoi') THEN 'Chuỗi'
     WHEN LOWER(unit) IN ('hộp','hop') THEN 'Hộp'
     ELSE UPPER(LEFT(unit,1)) || SUBSTRING(unit FROM 2)
   END`,
];

async function main() {
  console.log('→ Áp dụng tái cấu trúc bảng products...\n');
  for (const sql of STATEMENTS) {
    const label = sql.replace(/\s+/g, ' ').slice(0, 70);
    const affected = await prisma.$executeRawUnsafe(sql);
    console.log(`  ✓ ${label}${typeof affected === 'number' ? `  (${affected} rows)` : ''}`);
  }

  const total = await prisma.product.count();
  const withCategory = await prisma.product.count({ where: { category: { not: null } } });
  const withMaterial = await prisma.product.count({ where: { material: { not: null } } });

  const topCategories = await prisma.product.groupBy({
    by: ['category'],
    _count: { _all: true },
    orderBy: { _count: { category: 'desc' } },
    take: 12,
  });

  console.log(`\n=== KẾT QUẢ ===`);
  console.log(`Tổng products: ${total}`);
  console.log(`Có category:   ${withCategory}`);
  console.log(`Có material:   ${withMaterial}`);
  console.log('\nTop category:');
  for (const c of topCategories) {
    console.log(`  ${(c.category ?? '(trống)').padEnd(20)} ${c._count._all}`);
  }
  console.log('\n✓ Hoàn tất. (sapo_id sẽ được điền khi chạy import lại từ Sapo)');
}

main()
  .catch((e) => {
    console.error('❌ Lỗi:', e.message || e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
