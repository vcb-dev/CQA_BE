-- AlterEnum
ALTER TYPE "GoodsReceiptStatus" ADD VALUE 'huy';

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'mot_phan';

-- AlterTable
ALTER TABLE "categories" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "draft_orders" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "goods_receipts" ADD COLUMN     "paid_amount" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "order_return_items" ALTER COLUMN "product_name" DROP DEFAULT,
ALTER COLUMN "sku" DROP DEFAULT;

-- AlterTable
ALTER TABLE "orders" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "price_lists" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "products" ALTER COLUMN "updated_at" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "user_permission_overrides_user_id_warehouse_id_permission__key" RENAME TO "user_permission_overrides_user_id_warehouse_id_permission_i_key";
