-- Trả hàng nhập "theo đơn": gắn phiếu trả với đúng đơn nhập hàng gốc.
ALTER TABLE "purchase_returns" ADD COLUMN "goods_receipt_id" BIGINT;

ALTER TABLE "purchase_returns"
  ADD CONSTRAINT "purchase_returns_goods_receipt_id_fkey"
  FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
