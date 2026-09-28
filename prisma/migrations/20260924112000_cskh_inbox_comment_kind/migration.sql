-- Inbox conversation rows for FB comments (schema had these; first fb-comments migrate missed them).
ALTER TABLE "cskh_inbox_conversations" ADD COLUMN IF NOT EXISTS "kind" VARCHAR(16) NOT NULL DEFAULT 'dm';
ALTER TABLE "cskh_inbox_conversations" ADD COLUMN IF NOT EXISTS "source_post_id" VARCHAR(64);
ALTER TABLE "cskh_inbox_conversations" ADD COLUMN IF NOT EXISTS "source_permalink" TEXT;
ALTER TABLE "cskh_inbox_conversations" ADD COLUMN IF NOT EXISTS "source_thumb" TEXT;

CREATE INDEX IF NOT EXISTS "cskh_inbox_conversations_tenant_id_kind_last_message_at_idx"
  ON "cskh_inbox_conversations"("tenant_id", "kind", "last_message_at" DESC);
