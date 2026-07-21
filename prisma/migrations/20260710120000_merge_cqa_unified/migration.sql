-- Merge CQA CRM schema + unified users (data-safe)
-- Chạy trên DB đã có dữ liệu CQA hoặc Warehouse — không xóa bảng/cột hiện có.

-- ─── 1. Tenants (CQA) ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tenants" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "domain" VARCHAR,
    "logo_url" VARCHAR,
    "primary_color" VARCHAR,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- ─── 2. Users: bổ sung cột unified (giữ data cũ) ─────────────────────────────
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_url" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'password_hash'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "password_hash" TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'roles'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "roles" "UserRole"[] NOT NULL DEFAULT ARRAY[]::"UserRole"[];
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'status'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "status" "AccountStatus" NOT NULL DEFAULT 'active';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'name'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "name" TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'phone'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "phone" TEXT;
  END IF;
END $$;

-- Migrate CQA legacy columns → unified (chỉ khi cột legacy còn tồn tại)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'password'
  ) THEN
    UPDATE "users"
    SET "password_hash" = COALESCE("password_hash", "password")
    WHERE "password" IS NOT NULL;

    ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'full_name'
  ) THEN
    UPDATE "users"
    SET "name" = COALESCE("name", "full_name")
    WHERE "full_name" IS NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'phone_number'
  ) THEN
    UPDATE "users"
    SET "phone" = COALESCE("phone", "phone_number")
    WHERE "phone_number" IS NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'role'
  ) THEN
    UPDATE "users"
    SET "roles" = CASE
      WHEN "role" = 'admin' THEN ARRAY['admin']::"UserRole"[]
      WHEN "role" = 'manager' THEN ARRAY['store_manager']::"UserRole"[]
      WHEN "role" IN ('staff', 'user') THEN ARRAY['sales']::"UserRole"[]
      ELSE COALESCE("roles", ARRAY[]::"UserRole"[])
    END
    WHERE cardinality(COALESCE("roles", ARRAY[]::"UserRole"[])) = 0;
  END IF;
END $$;

-- users.id: INT (CQA legacy) → BIGINT
DO $$
DECLARE
  id_type text;
BEGIN
  SELECT data_type INTO id_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'id';

  IF id_type = 'integer' THEN
    ALTER TABLE "chat_audits" DROP CONSTRAINT IF EXISTS "chat_audits_user_id_fkey";
    ALTER TABLE "cskh_inbox_labels" DROP CONSTRAINT IF EXISTS "cskh_inbox_labels_user_id_fkey";
    ALTER TABLE "cskh_inbox_conversation_views" DROP CONSTRAINT IF EXISTS "cskh_inbox_conversation_views_user_id_fkey";

    ALTER TABLE "users" ALTER COLUMN "id" TYPE BIGINT;
    ALTER SEQUENCE IF EXISTS "users_id_seq" AS BIGINT;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'chat_audits' AND column_name = 'user_id') THEN
      ALTER TABLE "chat_audits" ALTER COLUMN "user_id" TYPE BIGINT;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cskh_inbox_labels' AND column_name = 'user_id') THEN
      ALTER TABLE "cskh_inbox_labels" ALTER COLUMN "user_id" TYPE BIGINT;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cskh_inbox_conversation_views' AND column_name = 'user_id') THEN
      ALTER TABLE "cskh_inbox_conversation_views" ALTER COLUMN "user_id" TYPE BIGINT;
    END IF;
  END IF;
END $$;

-- Drop legacy CQA columns sau khi copy data
ALTER TABLE "users" DROP COLUMN IF EXISTS "password";
ALTER TABLE "users" DROP COLUMN IF EXISTS "full_name";
ALTER TABLE "users" DROP COLUMN IF EXISTS "phone_number";
ALTER TABLE "users" DROP COLUMN IF EXISTS "role";

-- FK tenant
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_tenant_id_fkey'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── 3. CQA tables ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "chat_audits" (
    "id" UUID NOT NULL,
    "user_id" BIGINT,
    "agent_name" VARCHAR,
    "customer_name" VARCHAR,
    "channel" VARCHAR,
    "score" INTEGER NOT NULL DEFAULT 0,
    "feedback" TEXT,
    "transcript" JSONB,
    "metadata" JSONB,
    "tenant_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_audits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "facebook_cskh_configs" (
    "id" UUID NOT NULL,
    "page_id" TEXT NOT NULL,
    "page_name" VARCHAR,
    "page_access_token" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "tenant_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "facebook_cskh_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "facebook_oauth_sessions" (
    "id" UUID NOT NULL,
    "fb_user_id" TEXT NOT NULL,
    "fb_user_name" VARCHAR,
    "user_access_token" TEXT NOT NULL,
    "token_expires_at" TIMESTAMPTZ(6),
    "metadata" JSONB,
    "tenant_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "facebook_oauth_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "cskh_job_runs" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "summary" JSONB,
    "error" TEXT,
    "tenant_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    CONSTRAINT "cskh_job_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "cskh_monitor_items" (
    "id" UUID NOT NULL,
    "job_run_id" UUID NOT NULL,
    "page_id" TEXT NOT NULL,
    "page_name" VARCHAR,
    "conversation_id" TEXT NOT NULL,
    "customer_name" VARCHAR,
    "last_message" TEXT,
    "needs_reply" BOOLEAN NOT NULL DEFAULT true,
    "tenant_id" UUID,
    "updated_at" TIMESTAMPTZ(6),
    CONSTRAINT "cskh_monitor_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "cskh_inbox_conversations" (
    "id" UUID NOT NULL,
    "page_id" TEXT NOT NULL,
    "page_name" VARCHAR,
    "fb_conversation_id" VARCHAR,
    "participant_psid" TEXT NOT NULL,
    "customer_name" VARCHAR,
    "customer_picture_url" VARCHAR,
    "last_message" TEXT,
    "last_message_at" TIMESTAMPTZ(6),
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "awaiting_label" BOOLEAN NOT NULL DEFAULT false,
    "from_ad" BOOLEAN NOT NULL DEFAULT false,
    "ad_id" VARCHAR,
    "ad_title" VARCHAR,
    "referral_source" VARCHAR,
    "referral_at" TIMESTAMPTZ(6),
    "tenant_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cskh_inbox_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "cskh_inbox_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "fb_message_id" VARCHAR,
    "direction" TEXT NOT NULL,
    "sender_type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "message_type" TEXT NOT NULL DEFAULT 'text',
    "attachment_url" TEXT,
    "tenant_id" UUID,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'sent',
    CONSTRAINT "cskh_inbox_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "cskh_inbox_labels" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "name" VARCHAR(80) NOT NULL,
    "color" VARCHAR(20) NOT NULL DEFAULT '#6366f1',
    "type" VARCHAR(20) NOT NULL,
    "user_id" BIGINT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cskh_inbox_labels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "cskh_inbox_conversation_labels" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "label_id" UUID NOT NULL,
    "assigned_by_user_id" BIGINT,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cskh_inbox_conversation_labels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "cskh_inbox_conversation_views" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "user_id" BIGINT NOT NULL,
    "viewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cskh_inbox_conversation_views_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "cskh_page_ad_spend_daily" (
    "id" UUID NOT NULL,
    "page_id" TEXT NOT NULL,
    "stat_date" VARCHAR(10) NOT NULL,
    "spend" DOUBLE PRECISION,
    "currency" VARCHAR(8),
    "messaging_conversations" INTEGER,
    "cost_per_conversation" DOUBLE PRECISION,
    "ad_account_id" TEXT,
    "ad_account_name" VARCHAR,
    "unavailable_reason" VARCHAR(64),
    "tenant_id" UUID,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cskh_page_ad_spend_daily_pkey" PRIMARY KEY ("id")
);

-- ─── 4. Indexes & uniques (idempotent) ───────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "facebook_cskh_configs_page_id_key" ON "facebook_cskh_configs"("page_id");
CREATE UNIQUE INDEX IF NOT EXISTS "facebook_oauth_sessions_fb_user_id_key" ON "facebook_oauth_sessions"("fb_user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "cskh_inbox_conversations_page_id_participant_psid_key" ON "cskh_inbox_conversations"("page_id", "participant_psid");
CREATE UNIQUE INDEX IF NOT EXISTS "cskh_inbox_messages_fb_message_id_key" ON "cskh_inbox_messages"("fb_message_id");
CREATE UNIQUE INDEX IF NOT EXISTS "cskh_inbox_conversation_labels_conversation_id_label_id_key" ON "cskh_inbox_conversation_labels"("conversation_id", "label_id");
CREATE UNIQUE INDEX IF NOT EXISTS "cskh_inbox_conversation_views_conversation_id_user_id_key" ON "cskh_inbox_conversation_views"("conversation_id", "user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "cskh_inbox_labels_tenant_id_type_user_id_key" ON "cskh_inbox_labels"("tenant_id", "type", "user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "cskh_inbox_labels_tenant_id_type_name_key" ON "cskh_inbox_labels"("tenant_id", "type", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "cskh_page_ad_spend_daily_page_id_stat_date_key" ON "cskh_page_ad_spend_daily"("page_id", "stat_date");

CREATE INDEX IF NOT EXISTS "chat_audits_tenant_id_idx" ON "chat_audits"("tenant_id");
CREATE INDEX IF NOT EXISTS "chat_audits_tenant_id_created_at_idx" ON "chat_audits"("tenant_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "cskh_inbox_conversations_tenant_id_last_message_at_id_idx" ON "cskh_inbox_conversations"("tenant_id", "last_message_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "cskh_inbox_conversations_page_id_last_message_at_id_idx" ON "cskh_inbox_conversations"("page_id", "last_message_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "cskh_inbox_messages_conversation_id_sent_at_idx" ON "cskh_inbox_messages"("conversation_id", "sent_at" DESC);
CREATE INDEX IF NOT EXISTS "cskh_inbox_labels_tenant_id_type_sort_order_idx" ON "cskh_inbox_labels"("tenant_id", "type", "sort_order");

-- ─── 5. Foreign keys (idempotent) ────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "chat_audits" ADD CONSTRAINT "chat_audits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "chat_audits" ADD CONSTRAINT "chat_audits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "facebook_cskh_configs" ADD CONSTRAINT "facebook_cskh_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "facebook_oauth_sessions" ADD CONSTRAINT "facebook_oauth_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cskh_job_runs" ADD CONSTRAINT "cskh_job_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cskh_monitor_items" ADD CONSTRAINT "cskh_monitor_items_job_run_id_fkey" FOREIGN KEY ("job_run_id") REFERENCES "cskh_job_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cskh_monitor_items" ADD CONSTRAINT "cskh_monitor_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cskh_inbox_conversations" ADD CONSTRAINT "cskh_inbox_conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cskh_inbox_messages" ADD CONSTRAINT "cskh_inbox_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "cskh_inbox_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cskh_inbox_messages" ADD CONSTRAINT "cskh_inbox_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cskh_inbox_labels" ADD CONSTRAINT "cskh_inbox_labels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cskh_inbox_labels" ADD CONSTRAINT "cskh_inbox_labels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cskh_inbox_conversation_labels" ADD CONSTRAINT "cskh_inbox_conversation_labels_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "cskh_inbox_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cskh_inbox_conversation_labels" ADD CONSTRAINT "cskh_inbox_conversation_labels_label_id_fkey" FOREIGN KEY ("label_id") REFERENCES "cskh_inbox_labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cskh_inbox_conversation_views" ADD CONSTRAINT "cskh_inbox_conversation_views_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "cskh_inbox_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cskh_inbox_conversation_views" ADD CONSTRAINT "cskh_inbox_conversation_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
