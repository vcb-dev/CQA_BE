-- Tái cấu trúc bảng products: tách product_type "LOẠI >> CHẤT LIỆU" thành category + material,
-- thêm sapo_id (khóa đối chiếu Sapo) và một số trường bổ sung. An toàn để chạy lại (idempotent).
-- Chạy trên Supabase SQL Editor hoặc psql.

-- 1) Thêm cột mới
ALTER TABLE products ADD COLUMN IF NOT EXISTS sapo_id BIGINT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS material TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS craft_type TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_discontinued BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sapo_created_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sapo_updated_at TIMESTAMPTZ;

ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS title TEXT;

-- 2) Unique index cho sapo_id (nhiều NULL vẫn hợp lệ trong Postgres)
CREATE UNIQUE INDEX IF NOT EXISTS products_sapo_id_key ON products (sapo_id);
CREATE INDEX IF NOT EXISTS products_category_material_idx ON products (category, material);

-- 3) Backfill category / material từ product_type cũ (dạng "NHẪN >> Bạc")
UPDATE products
SET
  category = NULLIF(TRIM(SPLIT_PART(product_type, '>>', 1)), ''),
  material = NULLIF(TRIM(SPLIT_PART(product_type, '>>', 2)), '')
WHERE product_type IS NOT NULL
  AND product_type <> ''
  AND category IS NULL
  AND material IS NULL;

-- 4) Chuẩn hóa đơn vị tính products.unit (gộp hoa/thường, bỏ giá trị rác chứa số)
UPDATE products SET unit = CASE
  WHEN unit IS NULL OR TRIM(unit) = '' THEN NULL
  WHEN unit ~ '[0-9]' THEN NULL
  WHEN LOWER(unit) IN ('chiếc', 'chiec') THEN 'Chiếc'
  WHEN LOWER(unit) IN ('cái', 'cai') THEN 'Cái'
  WHEN LOWER(unit) IN ('đôi', 'doi') THEN 'Đôi'
  WHEN LOWER(unit) IN ('cặp', 'cap') THEN 'Cặp'
  WHEN LOWER(unit) IN ('viên', 'vien') THEN 'Viên'
  WHEN LOWER(unit) = 'dây' THEN 'Dây'
  WHEN LOWER(unit) = 'set' THEN 'Set'
  WHEN LOWER(unit) IN ('bộ', 'bo') THEN 'Bộ'
  WHEN LOWER(unit) IN ('chuỗi', 'chuoi') THEN 'Chuỗi'
  WHEN LOWER(unit) IN ('hộp', 'hop') THEN 'Hộp'
  ELSE UPPER(LEFT(unit, 1)) || SUBSTRING(unit FROM 2)
END;
