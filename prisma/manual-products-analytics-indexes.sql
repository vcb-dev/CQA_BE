-- Index giúp trang Sản phẩm / analytics load nhanh hơn
CREATE INDEX IF NOT EXISTS products_published_active_name_idx
  ON products (name ASC)
  WHERE is_published = true AND is_discontinued = false;

CREATE INDEX IF NOT EXISTS products_published_active_category_idx
  ON products (category ASC)
  WHERE is_published = true AND is_discontinued = false AND category IS NOT NULL;

CREATE INDEX IF NOT EXISTS product_variants_product_id_idx
  ON product_variants (product_id);
