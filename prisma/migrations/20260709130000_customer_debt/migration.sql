-- Công nợ khách hàng (khớp mô hình Sapo): sổ công nợ + trạng thái thanh toán trên đơn.
-- amount: dương = tăng nợ phải thu, âm = giảm nợ phải thu.

CREATE TYPE "CustomerLedgerReferenceType" AS ENUM ('order', 'payment', 'order_return', 'refund', 'adjustment');

CREATE TABLE customer_ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  reference_type "CustomerLedgerReferenceType" NOT NULL,
  reference_code TEXT,
  transaction_label TEXT NOT NULL,
  reason TEXT,
  amount DECIMAL(18,2) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX customer_ledger_entries_customer_id_created_at_idx
  ON customer_ledger_entries(customer_id, created_at);

ALTER TABLE orders
  ADD COLUMN payment_status "PaymentStatus" NOT NULL DEFAULT 'chua_thanh_toan',
  ADD COLUMN paid_amount DECIMAL(18,2) NOT NULL DEFAULT 0;

-- Backfill: hệ thống trước đây không theo dõi thanh toán đơn bán — coi lịch sử là đã
-- tất toán để không phát sinh nợ ảo; công nợ KH chỉ ghi nhận từ đơn tạo sau migration.
UPDATE orders
SET payment_status = 'da_thanh_toan', paid_amount = total_amount
WHERE status <> 'cancelled';
