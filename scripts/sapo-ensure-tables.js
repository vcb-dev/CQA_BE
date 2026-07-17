/** Tạo bảng Sapo nếu chưa có (không xóa dữ liệu). */
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe(`
CREATE TABLE IF NOT EXISTS sapo_catalog_variants (
  id SERIAL PRIMARY KEY,
  sapo_product_id INTEGER NOT NULL,
  sapo_variant_id INTEGER NOT NULL UNIQUE,
  product_title TEXT NOT NULL,
  variant_title TEXT NOT NULL DEFAULT 'Default',
  price NUMERIC(18, 2) NOT NULL DEFAULT 0,
  compare_at_price NUMERIC(18, 2),
  sku VARCHAR(64),
  tags TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  inventory_qty INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS sapo_catalog_variants_is_active_idx ON sapo_catalog_variants (is_active)',
  );
  console.log('Tables ready: sapo_catalog_variants');
}

main()
  .catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
