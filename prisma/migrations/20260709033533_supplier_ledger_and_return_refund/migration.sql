-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('chua_hoan_tien', 'da_hoan_tien');

-- CreateEnum
CREATE TYPE "SupplierLedgerReferenceType" AS ENUM ('goods_receipt', 'payment', 'purchase_return', 'refund', 'adjustment');

-- AlterTable
ALTER TABLE "purchase_returns" ADD COLUMN     "refund_status" "RefundStatus" NOT NULL DEFAULT 'chua_hoan_tien',
ADD COLUMN     "refunded_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "supplier_ledger_entries" (
    "id" BIGSERIAL NOT NULL,
    "supplier_id" BIGINT NOT NULL,
    "reference_type" "SupplierLedgerReferenceType" NOT NULL,
    "reference_code" TEXT,
    "transaction_label" TEXT NOT NULL,
    "reason" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_ledger_entries_supplier_id_created_at_idx" ON "supplier_ledger_entries"("supplier_id", "created_at");

-- AddForeignKey
ALTER TABLE "supplier_ledger_entries" ADD CONSTRAINT "supplier_ledger_entries_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_ledger_entries" ADD CONSTRAINT "supplier_ledger_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
