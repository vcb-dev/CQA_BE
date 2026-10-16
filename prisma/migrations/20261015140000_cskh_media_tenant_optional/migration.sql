-- DropIndex
DROP INDEX "cskh_media_folders_tenant_id_name_key";

-- AlterTable
ALTER TABLE "cskh_media_folders" ALTER COLUMN "tenant_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "cskh_media_assets" ALTER COLUMN "tenant_id" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "cskh_media_folders_name_key" ON "cskh_media_folders"("name");