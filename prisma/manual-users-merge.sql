-- Chạy trên Supabase SQL Editor sau merge schema (CQA CRM → CQA_BE).
-- Cột cũ (password, full_name, phone_number, role) được giữ để rollback; BE đọc cột mới.

DO $$ BEGIN
  CREATE TYPE "UserRole" AS ENUM (
    'warehouse_staff',
    'purchasing',
    'store_manager',
    'sales',
    'admin'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AccountStatus" AS ENUM ('invited', 'active', 'inactive');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" VARCHAR;
UPDATE "users"
SET "password_hash" = "password"
WHERE "password_hash" IS NULL
  AND "password" IS NOT NULL;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "name" VARCHAR;
UPDATE "users"
SET "name" = "full_name"
WHERE "name" IS NULL
  AND "full_name" IS NOT NULL;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" VARCHAR;
UPDATE "users"
SET "phone" = "phone_number"
WHERE "phone" IS NULL
  AND "phone_number" IS NOT NULL;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "roles" "UserRole"[] DEFAULT ARRAY[]::"UserRole"[];

UPDATE "users"
SET "roles" = ARRAY['admin']::"UserRole"[]
WHERE "role" = 'admin'
  AND ("roles" IS NULL OR "roles" = ARRAY[]::"UserRole"[]);

UPDATE "users"
SET "roles" = ARRAY['sales']::"UserRole"[]
WHERE ("role" = 'user' OR "role" IS NULL)
  AND ("roles" IS NULL OR "roles" = ARRAY[]::"UserRole"[]);

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "status" "AccountStatus" NOT NULL DEFAULT 'active';

UPDATE "users"
SET "status" = 'inactive'
WHERE "is_active" = false;
