-- CskhInboxConversation.needsReply
ALTER TABLE "cskh_inbox_conversations"
  ADD COLUMN IF NOT EXISTS "needs_reply" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX IF EXISTS "cskh_inbox_conversations_tenant_id_last_message_at_id_idx";

CREATE INDEX IF NOT EXISTS "cskh_inbox_conversations_tenant_id_needs_reply_last_message_at_id_idx"
  ON "cskh_inbox_conversations"("tenant_id", "needs_reply", "last_message_at" DESC, "id" DESC);