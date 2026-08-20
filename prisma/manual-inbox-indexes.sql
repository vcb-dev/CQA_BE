-- Chạy trên Supabase SQL Editor nếu prisma db push lỗi qua pooler
CREATE INDEX CONCURRENTLY IF NOT EXISTS "cskh_inbox_conversations_tenant_id_last_message_at_idx"
  ON "cskh_inbox_conversations" ("tenant_id", "last_message_at" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "cskh_inbox_conversations_page_id_last_message_at_idx"
  ON "cskh_inbox_conversations" ("page_id", "last_message_at" DESC);

-- Keyset pagination (cuộn load-more) — thêm cột id để tránh quét chậm khi trùng timestamp
CREATE INDEX CONCURRENTLY IF NOT EXISTS "cskh_inbox_conversations_tenant_lastmsg_id_idx"
  ON "cskh_inbox_conversations" ("tenant_id", "last_message_at" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "cskh_inbox_conversations_page_lastmsg_id_idx"
  ON "cskh_inbox_conversations" ("page_id", "last_message_at" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "cskh_inbox_conversations_tenant_fromad_lastmsg_id_idx"
  ON "cskh_inbox_conversations" ("tenant_id", "from_ad", "last_message_at" DESC, "id" DESC);

-- Tab chưa đọc + COUNT unread — không seq-scan 1.5 triệu dòng
CREATE INDEX CONCURRENTLY IF NOT EXISTS "cskh_inbox_conversations_unread_tenant_idx"
  ON "cskh_inbox_conversations" ("tenant_id", "last_message_at" DESC, "id" DESC)
  WHERE unread_count > 0 OR awaiting_label = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "cskh_inbox_conversations_unread_page_idx"
  ON "cskh_inbox_conversations" ("page_id", "last_message_at" DESC, "id" DESC)
  WHERE unread_count > 0 OR awaiting_label = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "cskh_inbox_messages_conversation_id_sent_at_idx"
  ON "cskh_inbox_messages" ("conversation_id", "sent_at" DESC);
