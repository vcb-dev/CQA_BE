-- CreateTable
CREATE TABLE "cskh_media_folders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cskh_media_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cskh_media_assets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "folder_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "mime_type" VARCHAR(80) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cskh_media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cskh_media_folders_tenant_id_name_key" ON "cskh_media_folders"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "cskh_media_assets_tenant_id_idx" ON "cskh_media_assets"("tenant_id");

-- CreateIndex
CREATE INDEX "cskh_media_assets_folder_id_idx" ON "cskh_media_assets"("folder_id");

-- AddForeignKey
ALTER TABLE "cskh_media_folders" ADD CONSTRAINT "cskh_media_folders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cskh_media_assets" ADD CONSTRAINT "cskh_media_assets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cskh_media_assets" ADD CONSTRAINT "cskh_media_assets_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "cskh_media_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;