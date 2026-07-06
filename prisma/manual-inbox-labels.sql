-- Chạy trên Supabase SQL Editor sau khi deploy BE mới
CREATE TABLE IF NOT EXISTS "cskh_inbox_labels" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" VARCHAR(80) NOT NULL,
  "color" VARCHAR(20) NOT NULL DEFAULT '#6366f1',
  "type" VARCHAR(20) NOT NULL,
  "user_id" INTEGER REFERENCES "users"("id") ON DELETE CASCADE,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("tenant_id", "type", "user_id"),
  UNIQUE ("tenant_id", "type", "name")
);

CREATE INDEX IF NOT EXISTS "cskh_inbox_labels_tenant_type_sort_idx"
  ON "cskh_inbox_labels" ("tenant_id", "type", "sort_order");

CREATE TABLE IF NOT EXISTS "cskh_inbox_conversation_labels" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id" UUID NOT NULL REFERENCES "cskh_inbox_conversations"("id") ON DELETE CASCADE,
  "label_id" UUID NOT NULL REFERENCES "cskh_inbox_labels"("id") ON DELETE CASCADE,
  "assigned_by_user_id" INTEGER,
  "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("conversation_id", "label_id")
);

CREATE INDEX IF NOT EXISTS "cskh_inbox_conversation_labels_conv_idx"
  ON "cskh_inbox_conversation_labels" ("conversation_id");

CREATE INDEX IF NOT EXISTS "cskh_inbox_conversation_labels_label_idx"
  ON "cskh_inbox_conversation_labels" ("label_id");

ALTER TABLE "cskh_inbox_conversations"
  ADD COLUMN IF NOT EXISTS "awaiting_label" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "cskh_inbox_conversation_views" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id" UUID NOT NULL REFERENCES "cskh_inbox_conversations"("id") ON DELETE CASCADE,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "viewed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("conversation_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "cskh_inbox_conversation_views_conv_idx"
  ON "cskh_inbox_conversation_views" ("conversation_id", "viewed_at" DESC);
