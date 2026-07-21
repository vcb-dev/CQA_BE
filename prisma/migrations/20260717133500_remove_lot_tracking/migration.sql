-- Bỏ tracking theo lô/batch — tồn kho chỉ còn theo variant + kho.
-- Backup dữ liệu lô trước khi drop: /Users/m1/Documents/sapo_vs2/backup_lots_20260717/

-- DropForeignKey
ALTER TABLE "goods_receipt_items" DROP CONSTRAINT "goods_receipt_items_lot_id_fkey";

-- DropForeignKey
ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_lot_id_fkey";

-- DropForeignKey
ALTER TABLE "lots" DROP CONSTRAINT "lots_variant_id_fkey";

-- DropForeignKey
ALTER TABLE "purchase_return_items" DROP CONSTRAINT "purchase_return_items_lot_id_fkey";

-- DropForeignKey
ALTER TABLE "stock_transfer_items" DROP CONSTRAINT "stock_transfer_items_lot_id_fkey";

-- AlterTable
ALTER TABLE "goods_receipt_items" DROP COLUMN "lot_id";

-- AlterTable
ALTER TABLE "inventory_movements" DROP COLUMN "lot_id";

-- AlterTable
ALTER TABLE "purchase_return_items" DROP COLUMN "lot_id";

-- AlterTable
ALTER TABLE "stock_transfer_items" DROP COLUMN "lot_id";

-- DropTable
DROP TABLE "lots";
