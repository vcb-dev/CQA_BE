-- AlterTable
ALTER TABLE "goods_receipts" ADD COLUMN     "assigned_to" BIGINT,
ADD COLUMN     "discount_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "expected_receipt_at" TIMESTAMP(3),
ADD COLUMN     "extra_cost" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "invoice_at" TIMESTAMP(3),
ADD COLUMN     "order_code" TEXT,
ADD COLUMN     "reference_code" TEXT;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
