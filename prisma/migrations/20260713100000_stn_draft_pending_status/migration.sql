-- Chuyển kho: thêm trạng thái "Phiếu nháp" (nhap) và "Chờ chuyển" (cho_chuyen)
-- trước "Đang chuyển" (dang_chuyen) — giữ tồn bằng bucket committed trước khi
-- xuất kho thật, giống pattern order_reserve/order_release/order_ship.
ALTER TYPE "StockTransferStatus" ADD VALUE IF NOT EXISTS 'nhap' BEFORE 'dang_chuyen';
ALTER TYPE "StockTransferStatus" ADD VALUE IF NOT EXISTS 'cho_chuyen' BEFORE 'dang_chuyen';

ALTER TYPE "MovementType" ADD VALUE IF NOT EXISTS 'transfer_reserve';
ALTER TYPE "MovementType" ADD VALUE IF NOT EXISTS 'transfer_release';

ALTER TABLE "stock_transfers" ADD COLUMN "shipped_at" TIMESTAMP(3);

-- Không SET DEFAULT 'nhap' ở đây: Postgres không cho dùng giá trị enum vừa
-- ADD VALUE trong cùng transaction/migration. Ứng dụng luôn set status tường
-- minh khi tạo nên default cột không bắt buộc phải khớp ngay lập tức.
