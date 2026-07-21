-- Phiếu thu/chi (vouchers)

CREATE TYPE "VoucherType" AS ENUM ('receipt', 'payment');

CREATE TABLE "vouchers" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "type" "VoucherType" NOT NULL,
    "amount_in" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amount_out" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "branch_id" BIGINT NOT NULL,
    "created_by" BIGINT NOT NULL,
    "source_document" TEXT,
    "reference_type" TEXT,
    "reference_id" BIGINT,
    "reason" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vouchers_code_key" ON "vouchers"("code");
CREATE INDEX "vouchers_branch_id_type_recorded_at_idx" ON "vouchers"("branch_id", "type", "recorded_at");

ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
