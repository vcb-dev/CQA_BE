/** Tạo bảng products module nếu chưa có. */
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

const steps = [
  `CREATE TABLE IF NOT EXISTS branches (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(64) NOT NULL UNIQUE,
    name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
  )`,
  `CREATE TABLE IF NOT EXISTS warehouses (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(64) NOT NULL UNIQUE,
    name TEXT NOT NULL,
    branch_id BIGINT NOT NULL REFERENCES branches (id),
    is_active BOOLEAN NOT NULL DEFAULT TRUE
  )`,
  `INSERT INTO branches (code, name) VALUES ('MAIN', 'Chi nhánh chính') ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO warehouses (code, name, branch_id)
   SELECT 'MAIN-WH', 'Kho chính', b.id FROM branches b WHERE b.code = 'MAIN'
   ON CONFLICT (code) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    brand TEXT,
    product_type TEXT,
    unit TEXT,
    tags TEXT[] NOT NULL DEFAULT '{}',
    requires_shipping BOOLEAN NOT NULL DEFAULT TRUE,
    is_published BOOLEAN NOT NULL DEFAULT FALSE,
    taxable BOOLEAN NOT NULL DEFAULT TRUE,
    image_url TEXT,
    seo_title TEXT,
    seo_description TEXT,
    description TEXT,
    short_description TEXT,
    track_inventory BOOLEAN NOT NULL DEFAULT TRUE,
    allow_backorder BOOLEAN NOT NULL DEFAULT FALSE,
    tax_industry_group TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS products_brand_product_type_idx ON products (brand, product_type)`,
  `CREATE TABLE IF NOT EXISTS product_variants (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    sku VARCHAR(64) NOT NULL UNIQUE,
    barcode VARCHAR(64),
    price NUMERIC(18, 2) NOT NULL DEFAULT 0,
    compare_at_price NUMERIC(18, 2),
    cost NUMERIC(18, 2) NOT NULL DEFAULT 0,
    weight NUMERIC(18, 4),
    weight_unit TEXT,
    image_url TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE
  )`,
  `CREATE TABLE IF NOT EXISTS product_images (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    position INT NOT NULL DEFAULT 0,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  `CREATE INDEX IF NOT EXISTS product_images_product_id_position_idx ON product_images (product_id, position)`,
  `CREATE TABLE IF NOT EXISTS product_sales_channels (
    product_id BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    PRIMARY KEY (product_id, channel)
  )`,
  `CREATE TABLE IF NOT EXISTS inventory_levels (
    variant_id BIGINT NOT NULL REFERENCES product_variants (id),
    warehouse_id BIGINT NOT NULL REFERENCES warehouses (id),
    on_hand INT NOT NULL DEFAULT 0,
    committed INT NOT NULL DEFAULT 0,
    packing INT NOT NULL DEFAULT 0,
    unavailable INT NOT NULL DEFAULT 0,
    incoming INT NOT NULL DEFAULT 0,
    available INT NOT NULL DEFAULT 0,
    price NUMERIC(18, 2) NOT NULL DEFAULT 0,
    cost NUMERIC(18, 2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (variant_id, warehouse_id)
  )`,
  `CREATE TABLE IF NOT EXISTS sapo_inbox_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number SERIAL UNIQUE,
    conversation_id UUID,
    participant_psid VARCHAR(64),
    customer_name TEXT NOT NULL,
    phone VARCHAR(32),
    address TEXT,
    note TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    total_price NUMERIC(18, 2) NOT NULL DEFAULT 0,
    source VARCHAR(16) NOT NULL DEFAULT 'db',
    external_order_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS sapo_inbox_orders_conversation_id_idx ON sapo_inbox_orders (conversation_id)`,
  `CREATE INDEX IF NOT EXISTS sapo_inbox_orders_created_at_idx ON sapo_inbox_orders (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sapo_inbox_order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES sapo_inbox_orders (id) ON DELETE CASCADE,
    variant_id BIGINT NOT NULL REFERENCES product_variants (id),
    product_name TEXT NOT NULL,
    unit_price NUMERIC(18, 2) NOT NULL,
    quantity INT NOT NULL,
    line_total NUMERIC(18, 2) NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sapo_inbox_order_items_order_id_idx ON sapo_inbox_order_items (order_id)`,
];

async function main() {
  for (const sql of steps) {
    await prisma.$executeRawUnsafe(sql);
  }
  console.log('Products module tables ready.');
}

main()
  .catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
