-- Ký hiệu hóa đơn NCC (VD: 2C26MYY) để đối chiếu với hóa đơn bán hàng
ALTER TABLE "goods_receipts" ADD COLUMN "invoice_symbol" TEXT;

-- PO gắn theo từng dòng sản phẩm của phiếu nhập (thay vì chỉ gắn cả phiếu)
ALTER TABLE "goods_receipt_items" ADD COLUMN "purchase_order_id" BIGINT;

ALTER TABLE "goods_receipt_items"
  ADD CONSTRAINT "goods_receipt_items_purchase_order_id_fkey"
  FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: phiếu cũ gắn PO ở header thì mọi dòng đều thuộc PO đó
UPDATE "goods_receipt_items" gri
SET "purchase_order_id" = gr."purchase_order_id"
FROM "goods_receipts" gr
WHERE gri."goods_receipt_id" = gr."id"
  AND gr."purchase_order_id" IS NOT NULL;
