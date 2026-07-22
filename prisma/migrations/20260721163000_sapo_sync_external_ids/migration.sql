-- AlterEnum
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'sapo';

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN IF NOT EXISTS "sapo_id" BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS "product_variants_sapo_id_key" ON "product_variants"("sapo_id");

ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "sapo_id" BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS "customers_sapo_id_key" ON "customers"("sapo_id");
CREATE INDEX IF NOT EXISTS "customers_email_idx" ON "customers"("email");

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "sapo_id" BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS "orders_sapo_id_key" ON "orders"("sapo_id");

ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "sapo_id" BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS "categories_sapo_id_key" ON "categories"("sapo_id");
