-- Sapo mirror tables for UI/reporting (flattened columns)

CREATE TABLE IF NOT EXISTS "sapo_customers" (
  "id" BIGSERIAL PRIMARY KEY,
  "sapo_id" BIGINT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "first_name" TEXT,
  "last_name" TEXT,
  "full_name" TEXT,
  "gender" TEXT,
  "dob" DATE,
  "company" TEXT,
  "accepts_marketing" BOOLEAN NOT NULL DEFAULT false,
  "verified_email" BOOLEAN NOT NULL DEFAULT false,
  "state" TEXT,
  "orders_count" INTEGER NOT NULL DEFAULT 0,
  "total_spent" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "last_order_sapo_id" BIGINT,
  "last_order_name" TEXT,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "note" TEXT,
  "address_name" TEXT,
  "address_phone" TEXT,
  "address1" TEXT,
  "address2" TEXT,
  "ward" TEXT,
  "district" TEXT,
  "city" TEXT,
  "province" TEXT,
  "province_code" TEXT,
  "district_code" TEXT,
  "ward_code" TEXT,
  "country" TEXT,
  "country_code" TEXT,
  "zip" TEXT,
  "sapo_created_at" TIMESTAMPTZ,
  "sapo_modified_at" TIMESTAMPTZ,
  "synced_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "sapo_customers_sapo_id_key" ON "sapo_customers"("sapo_id");
CREATE INDEX IF NOT EXISTS "sapo_customers_phone_idx" ON "sapo_customers"("phone");
CREATE INDEX IF NOT EXISTS "sapo_customers_email_idx" ON "sapo_customers"("email");
CREATE INDEX IF NOT EXISTS "sapo_customers_full_name_idx" ON "sapo_customers"("full_name");

CREATE TABLE IF NOT EXISTS "sapo_orders" (
  "id" BIGSERIAL PRIMARY KEY,
  "sapo_id" BIGINT NOT NULL,
  "code" TEXT NOT NULL,
  "order_number" INTEGER,
  "sapo_status" TEXT,
  "financial_status" TEXT,
  "fulfillment_status" TEXT,
  "gateway" TEXT,
  "source_name" TEXT,
  "currency" TEXT DEFAULT 'VND',
  "email" TEXT,
  "phone" TEXT,
  "note" TEXT,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "cancel_reason" TEXT,
  "customer_sapo_id" BIGINT,
  "customer_name" TEXT,
  "customer_id" BIGINT,
  "subtotal_price" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "total_line_items_price" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "total_discounts" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "total_tax" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "total_shipping_price" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "total_price" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "total_outstanding" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "unpaid_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "total_received" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "total_refunded" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "item_quantity" INTEGER NOT NULL DEFAULT 0,
  "created_on" TIMESTAMPTZ,
  "modified_on" TIMESTAMPTZ,
  "paid_on" TIMESTAMPTZ,
  "cancelled_on" TIMESTAMPTZ,
  "closed_on" TIMESTAMPTZ,
  "expected_delivery_date" TIMESTAMPTZ,
  "ship_name" TEXT,
  "ship_phone" TEXT,
  "ship_company" TEXT,
  "ship_address1" TEXT,
  "ship_address2" TEXT,
  "ship_ward" TEXT,
  "ship_district" TEXT,
  "ship_city" TEXT,
  "ship_province" TEXT,
  "ship_country" TEXT,
  "ship_zip" TEXT,
  "bill_name" TEXT,
  "bill_phone" TEXT,
  "bill_address1" TEXT,
  "bill_district" TEXT,
  "bill_city" TEXT,
  "bill_province" TEXT,
  "bill_country" TEXT,
  "synced_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "sapo_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "sapo_customers"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "sapo_orders_sapo_id_key" ON "sapo_orders"("sapo_id");
CREATE INDEX IF NOT EXISTS "sapo_orders_code_idx" ON "sapo_orders"("code");
CREATE INDEX IF NOT EXISTS "sapo_orders_financial_status_idx" ON "sapo_orders"("financial_status");
CREATE INDEX IF NOT EXISTS "sapo_orders_fulfillment_status_idx" ON "sapo_orders"("fulfillment_status");
CREATE INDEX IF NOT EXISTS "sapo_orders_sapo_status_idx" ON "sapo_orders"("sapo_status");
CREATE INDEX IF NOT EXISTS "sapo_orders_created_on_idx" ON "sapo_orders"("created_on");
CREATE INDEX IF NOT EXISTS "sapo_orders_customer_sapo_id_idx" ON "sapo_orders"("customer_sapo_id");
CREATE INDEX IF NOT EXISTS "sapo_orders_phone_idx" ON "sapo_orders"("phone");

CREATE TABLE IF NOT EXISTS "sapo_order_line_items" (
  "id" BIGSERIAL PRIMARY KEY,
  "order_id" BIGINT NOT NULL,
  "sapo_line_item_id" BIGINT,
  "product_sapo_id" BIGINT,
  "variant_sapo_id" BIGINT,
  "title" TEXT,
  "variant_title" TEXT,
  "name" TEXT,
  "sku" TEXT,
  "vendor" TEXT,
  "unit" TEXT,
  "quantity" INTEGER NOT NULL DEFAULT 0,
  "price" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "total_discount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "discounted_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "fulfillment_status" TEXT,
  "requires_shipping" BOOLEAN NOT NULL DEFAULT true,
  "taxable" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "sapo_order_line_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sapo_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "sapo_order_line_items_order_id_idx" ON "sapo_order_line_items"("order_id");
CREATE INDEX IF NOT EXISTS "sapo_order_line_items_sku_idx" ON "sapo_order_line_items"("sku");
CREATE INDEX IF NOT EXISTS "sapo_order_line_items_product_sapo_id_idx" ON "sapo_order_line_items"("product_sapo_id");
CREATE INDEX IF NOT EXISTS "sapo_order_line_items_variant_sapo_id_idx" ON "sapo_order_line_items"("variant_sapo_id");
