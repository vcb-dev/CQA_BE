-- IG CDN URLs often exceed 512 chars
ALTER TABLE "cskh_ig_media" ALTER COLUMN "permalink" TYPE TEXT;
ALTER TABLE "cskh_ig_media" ALTER COLUMN "thumbnail_url" TYPE TEXT;
