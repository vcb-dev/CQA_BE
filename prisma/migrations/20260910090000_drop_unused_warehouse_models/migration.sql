-- Drop warehouse leftovers not used by CQA CRM source.
-- KEEP: users, tenants, locations, products*, categories, inventory_levels,
-- customers, orders, order_items, chat_audits, facebook_*, cskh_*, sapo_*, pancake_*.
-- Single CASCADE list so leftover FKs between unused tables do not block.

DROP TABLE IF EXISTS
  "carrier_ticket_messages",
  "carrier_tickets",
  "fulfillment_line_items",
  "fulfillments",
  "order_refund_items",
  "order_refunds",
  "order_shipping_lines",
  "customer_addresses",
  "customer_group_members",
  "variant_price_histories",
  "user_location_roles",
  "user_locations",
  "api_keys",
  "saved_reports",
  "shipping_providers",
  "conversation_messages",
  "conversations",
  "draft_order_items",
  "draft_orders",
  "order_return_items",
  "order_returns",
  "vouchers",
  "customer_ledger_entries",
  "supplier_ledger_entries",
  "purchase_return_items",
  "purchase_returns",
  "stock_transfer_items",
  "stock_transfers",
  "goods_receipt_items",
  "goods_receipts",
  "purchase_order_items",
  "purchase_orders",
  "suppliers",
  "inventory_movements",
  "lots",
  "activity_logs",
  "price_list_items",
  "price_lists",
  "customer_groups",
  "variant_option_values",
  "product_options",
  "product_categories",
  "user_permission_overrides",
  "user_warehouse_roles",
  "role_permissions",
  "user_warehouses",
  "user_invitations",
  "permissions",
  "roles"
CASCADE;

DROP TYPE IF EXISTS "PermissionScope";
DROP TYPE IF EXISTS "InventoryBucket";
DROP TYPE IF EXISTS "MovementType";
DROP TYPE IF EXISTS "PoStatus";
DROP TYPE IF EXISTS "GoodsReceiptStatus";
DROP TYPE IF EXISTS "StockTransferStatus";
DROP TYPE IF EXISTS "RefundStatus";
DROP TYPE IF EXISTS "DraftOrderStatus";
DROP TYPE IF EXISTS "VoucherType";
DROP TYPE IF EXISTS "SupplierLedgerReferenceType";
DROP TYPE IF EXISTS "CustomerLedgerReferenceType";
