ALTER TABLE "cskh_media_assets" ADD COLUMN "public_id" VARCHAR(512) NOT NULL;
ALTER TABLE "cskh_media_assets" ADD COLUMN "url" TEXT NOT NULL;
ALTER TABLE "cskh_media_assets" DROP COLUMN "data";