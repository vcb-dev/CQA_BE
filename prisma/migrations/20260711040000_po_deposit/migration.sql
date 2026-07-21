-- Tiền cọc đặt hàng nhập: cọc trên PO + phần cọc đã cấn trừ trên từng phiếu nhập
ALTER TABLE "purchase_orders" ADD COLUMN "deposit_amount" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "goods_receipts" ADD COLUMN "deposit_applied" DECIMAL(18,2) NOT NULL DEFAULT 0;
