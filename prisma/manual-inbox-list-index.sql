-- List hội thoại "Tất cả kênh" ORDER BY last_message_at DESC LIMIT 50
-- không dùng được index (tenant_id, last_message_at) khi tenant_id null.
-- Chạy trên Supabase SQL Editor (không bọc transaction).

CREATE INDEX CONCURRENTLY IF NOT EXISTS cskh_inbox_conversations_last_msg_id_idx
  ON cskh_inbox_conversations (last_message_at DESC, id DESC);

ANALYZE cskh_inbox_conversations;
