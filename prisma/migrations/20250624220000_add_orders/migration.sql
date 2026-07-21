-- Module Đơn hàng (002)

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'sales';

CREATE TYPE "OrderStatus" AS ENUM ('ordered', 'processing', 'completed', 'cancelled', 'returned');
CREATE TYPE "DraftOrderStatus" AS ENUM ('draft', 'confirmed');
CREATE TYPE "OrderSource" AS ENUM ('facebook', 'tiktok', 'shopee', 'pos', 'web', 'zalo', 'live_fb', 'warranty', 'other');

CREATE TABLE "customers" (
    "id" BIGSERIAL NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "company" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customers_phone_idx" ON "customers"("phone");

CREATE TABLE "orders" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "customer_id" BIGINT,
    "branch_id" BIGINT NOT NULL,
    "source" "OrderSource" NOT NULL DEFAULT 'other',
    "status" "OrderStatus" NOT NULL DEFAULT 'ordered',
    "assigned_to" BIGINT,
    "created_by" BIGINT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "shipping_fee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total_quantity" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ordered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_delivery_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "orders_code_key" ON "orders"("code");
CREATE INDEX "orders_branch_id_status_ordered_at_idx" ON "orders"("branch_id", "status", "ordered_at");

CREATE TABLE "order_items" (
    "id" BIGSERIAL NOT NULL,
    "order_id" BIGINT NOT NULL,
    "variant_id" BIGINT NOT NULL,
    "warehouse_id" BIGINT NOT NULL,
    "product_name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DECIMAL(18,2) NOT NULL,
    "discount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL,
    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "draft_orders" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "branch_id" BIGINT NOT NULL,
    "customer_id" BIGINT,
    "source" "OrderSource" NOT NULL DEFAULT 'other',
    "status" "DraftOrderStatus" NOT NULL DEFAULT 'draft',
    "created_by" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "shipping_fee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "shipping_method" TEXT,
    "note" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "converted_order_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "draft_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "draft_orders_code_key" ON "draft_orders"("code");
CREATE UNIQUE INDEX "draft_orders_converted_order_id_key" ON "draft_orders"("converted_order_id");

CREATE TABLE "draft_order_items" (
    "id" BIGSERIAL NOT NULL,
    "draft_order_id" BIGINT NOT NULL,
    "variant_id" BIGINT NOT NULL,
    "warehouse_id" BIGINT NOT NULL,
    "product_name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DECIMAL(18,2) NOT NULL,
    "discount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    CONSTRAINT "draft_order_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "order_returns" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "order_id" BIGINT NOT NULL,
    "reason" TEXT,
    "refund_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "restock" BOOLEAN NOT NULL DEFAULT true,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "order_returns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_returns_code_key" ON "order_returns"("code");

CREATE TABLE "order_return_items" (
    "id" BIGSERIAL NOT NULL,
    "order_return_id" BIGINT NOT NULL,
    "variant_id" BIGINT NOT NULL,
    "warehouse_id" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DECIMAL(18,2) NOT NULL,
    CONSTRAINT "order_return_items_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "draft_orders" ADD CONSTRAINT "draft_orders_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "draft_orders" ADD CONSTRAINT "draft_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "draft_orders" ADD CONSTRAINT "draft_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "draft_orders" ADD CONSTRAINT "draft_orders_converted_order_id_fkey" FOREIGN KEY ("converted_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "draft_order_items" ADD CONSTRAINT "draft_order_items_draft_order_id_fkey" FOREIGN KEY ("draft_order_id") REFERENCES "draft_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "draft_order_items" ADD CONSTRAINT "draft_order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "draft_order_items" ADD CONSTRAINT "draft_order_items_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_return_items" ADD CONSTRAINT "order_return_items_order_return_id_fkey" FOREIGN KEY ("order_return_id") REFERENCES "order_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_return_items" ADD CONSTRAINT "order_return_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_return_items" ADD CONSTRAINT "order_return_items_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
