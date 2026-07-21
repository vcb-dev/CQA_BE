-- Align order_return_items with Excel export (product snapshot per line)
ALTER TABLE "order_return_items" ADD COLUMN "product_name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "order_return_items" ADD COLUMN "variant_title" TEXT;
ALTER TABLE "order_return_items" ADD COLUMN "sku" TEXT NOT NULL DEFAULT '';
