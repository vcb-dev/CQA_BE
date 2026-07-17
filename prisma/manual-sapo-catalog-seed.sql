-- Catalog Sapo mirror + seed SP test (chạy trên Supabase SQL Editor)
-- Dùng khi chưa có OAuth/Private App Sapo — test tạo đơn từ inbox CRM.

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
);

CREATE INDEX IF NOT EXISTS sapo_catalog_variants_is_active_idx ON sapo_catalog_variants (is_active);

CREATE TABLE IF NOT EXISTS sapo_inbox_orders (
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
);

CREATE INDEX IF NOT EXISTS sapo_inbox_orders_conversation_id_idx ON sapo_inbox_orders (conversation_id);
CREATE INDEX IF NOT EXISTS sapo_inbox_orders_created_at_idx ON sapo_inbox_orders (created_at DESC);

CREATE TABLE IF NOT EXISTS sapo_inbox_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES sapo_inbox_orders (id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL REFERENCES sapo_catalog_variants (sapo_variant_id),
  product_name TEXT NOT NULL,
  unit_price NUMERIC(18, 2) NOT NULL,
  quantity INTEGER NOT NULL,
  line_total NUMERIC(18, 2) NOT NULL
);

CREATE INDEX IF NOT EXISTS sapo_inbox_order_items_order_id_idx ON sapo_inbox_order_items (order_id);

-- Seed: kim hoàn & đá quý (tồn kho cố định để test)
INSERT INTO sapo_catalog_variants (
  sapo_product_id, sapo_variant_id, product_title, variant_title,
  price, compare_at_price, sku, tags, inventory_qty, is_active
) VALUES
  (90001, 100001, 'Nhẫn kim cương viên 0.3ct', 'Size 12', 18500000, 21000000, 'NKC-V03-S12', 'nhẫn,kim cương,viên', 5, TRUE),
  (90002, 100002, 'Dây chuyền vàng 18K', '45cm', 12800000, NULL, 'DCV-18K-45', 'dây chuyền,vàng', 12, TRUE),
  (90003, 100003, 'Lắc tay đá ruby', 'Free size', 9600000, 11200000, 'LCR-RUBY-01', 'lắc,ruby,đá quý', 3, TRUE),
  (90004, 100004, 'Bông tai ngọc trai Akoya', 'Cặp', 7200000, NULL, 'BTN-AKOYA', 'bông tai,ngọc trai', 8, TRUE),
  (90005, 100005, 'Nhẫn cưới platinum đôi', 'Nam size 18 / Nữ size 10', 24500000, 26800000, 'NC-PT-DOI', 'nhẫn cưới,platinum', 2, TRUE),
  (90006, 100006, 'Mặt dây chuyền sapphire xanh', 'Không kèm dây', 15400000, NULL, 'MDS-SAP-01', 'sapphire,mặt dây', 6, TRUE),
  (90007, 100007, 'Vòng tay vàng trắng 14K', '16cm', 8900000, 9500000, 'VT-14K-16', 'vòng tay,vàng trắng', 10, TRUE),
  (90008, 100008, 'Nhẫn nam titan đá moissanite', 'Size 9', 4200000, NULL, 'NN-TI-MOI', 'nhẫn nam,moissanite', 15, TRUE)
ON CONFLICT (sapo_variant_id) DO UPDATE SET
  product_title = EXCLUDED.product_title,
  variant_title = EXCLUDED.variant_title,
  price = EXCLUDED.price,
  compare_at_price = EXCLUDED.compare_at_price,
  sku = EXCLUDED.sku,
  tags = EXCLUDED.tags,
  inventory_qty = EXCLUDED.inventory_qty,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();
