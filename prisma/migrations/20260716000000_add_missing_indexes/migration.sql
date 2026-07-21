-- Bổ sung index còn thiếu (Postgres không tự tạo index cho cột FK).
-- Nhóm 1: FK cha trên các bảng line-item — nạp chi tiết chứng từ (include items)
-- Nhóm 2: variant_id trên các bảng item — check tham chiếu khi sửa/xóa sản phẩm
--          (product.repository.ts quét 8 bảng theo variant_id)
-- Nhóm 3: warehouse_id trên order/draft/return items — mọi list đơn đều lọc
--          items.some.warehouseId IN (kho user được cấp)
-- Nhóm 4: composite cho màn hình danh sách (lọc supplier/status + sort createdAt desc)

-- Sản phẩm
CREATE INDEX "product_variants_product_id_idx" ON "product_variants"("product_id");
CREATE INDEX "variant_option_values_option_id_idx" ON "variant_option_values"("option_id");
CREATE INDEX "product_categories_category_id_idx" ON "product_categories"("category_id");

-- Tồn kho
CREATE INDEX "inventory_levels_warehouse_id_idx" ON "inventory_levels"("warehouse_id");

-- Đặt hàng nhập
CREATE INDEX "purchase_orders_supplier_id_created_at_idx" ON "purchase_orders"("supplier_id", "created_at");
CREATE INDEX "purchase_orders_status_created_at_idx" ON "purchase_orders"("status", "created_at");
CREATE INDEX "purchase_orders_created_at_idx" ON "purchase_orders"("created_at");
CREATE INDEX "purchase_order_items_variant_id_idx" ON "purchase_order_items"("variant_id");

-- Nhập hàng
CREATE INDEX "goods_receipts_supplier_id_created_at_idx" ON "goods_receipts"("supplier_id", "created_at");
CREATE INDEX "goods_receipts_status_created_at_idx" ON "goods_receipts"("status", "created_at");
CREATE INDEX "goods_receipts_created_at_idx" ON "goods_receipts"("created_at");
CREATE INDEX "goods_receipts_purchase_order_id_idx" ON "goods_receipts"("purchase_order_id");
CREATE INDEX "goods_receipt_items_goods_receipt_id_idx" ON "goods_receipt_items"("goods_receipt_id");
CREATE INDEX "goods_receipt_items_variant_id_idx" ON "goods_receipt_items"("variant_id");

-- Chuyển kho
CREATE INDEX "stock_transfers_from_warehouse_id_idx" ON "stock_transfers"("from_warehouse_id");
CREATE INDEX "stock_transfers_to_warehouse_id_idx" ON "stock_transfers"("to_warehouse_id");
CREATE INDEX "stock_transfers_created_at_idx" ON "stock_transfers"("created_at");
CREATE INDEX "stock_transfer_items_stock_transfer_id_idx" ON "stock_transfer_items"("stock_transfer_id");
CREATE INDEX "stock_transfer_items_variant_id_idx" ON "stock_transfer_items"("variant_id");

-- Trả hàng nhập
CREATE INDEX "purchase_returns_supplier_id_created_at_idx" ON "purchase_returns"("supplier_id", "created_at");
CREATE INDEX "purchase_returns_goods_receipt_id_idx" ON "purchase_returns"("goods_receipt_id");
CREATE INDEX "purchase_returns_created_at_idx" ON "purchase_returns"("created_at");
CREATE INDEX "purchase_return_items_purchase_return_id_idx" ON "purchase_return_items"("purchase_return_id");
CREATE INDEX "purchase_return_items_variant_id_idx" ON "purchase_return_items"("variant_id");

-- Đơn hàng
CREATE INDEX "orders_ordered_at_idx" ON "orders"("ordered_at");
CREATE INDEX "orders_customer_id_idx" ON "orders"("customer_id");
CREATE INDEX "orders_assigned_to_idx" ON "orders"("assigned_to");
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");
CREATE INDEX "order_items_variant_id_idx" ON "order_items"("variant_id");
CREATE INDEX "order_items_warehouse_id_idx" ON "order_items"("warehouse_id");

-- Đơn nháp
CREATE INDEX "draft_orders_status_created_at_idx" ON "draft_orders"("status", "created_at");
CREATE INDEX "draft_orders_customer_id_idx" ON "draft_orders"("customer_id");
CREATE INDEX "draft_order_items_draft_order_id_idx" ON "draft_order_items"("draft_order_id");
CREATE INDEX "draft_order_items_variant_id_idx" ON "draft_order_items"("variant_id");
CREATE INDEX "draft_order_items_warehouse_id_idx" ON "draft_order_items"("warehouse_id");

-- Trả hàng bán
CREATE INDEX "order_returns_order_id_idx" ON "order_returns"("order_id");
CREATE INDEX "order_returns_created_at_idx" ON "order_returns"("created_at");
CREATE INDEX "order_return_items_order_return_id_idx" ON "order_return_items"("order_return_id");
CREATE INDEX "order_return_items_variant_id_idx" ON "order_return_items"("variant_id");
CREATE INDEX "order_return_items_warehouse_id_idx" ON "order_return_items"("warehouse_id");
