-- Prisma User dùng cột `name` (không đọc first_name/last_name).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "name" TEXT;

UPDATE "users"
SET "name" = COALESCE(
  NULLIF(TRIM("name"), ''),
  NULLIF(TRIM(CONCAT(COALESCE("first_name", ''), ' ', COALESCE("last_name", ''))), ''),
  "email"
)
WHERE "name" IS NULL
   OR TRIM("name") = '';
