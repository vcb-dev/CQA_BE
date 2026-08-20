-- Chạy trên Supabase SQL Editor, TỪNG CÂU, không bọc BEGIN/COMMIT
-- (CREATE INDEX CONCURRENTLY không chạy trong transaction).
-- Cần cho list Hội thoại "Tất cả kênh" khi user không có tenant_id
-- (ORDER BY last_message_at DESC LIMIT 50).

CREATE INDEX CONCURRENTLY IF NOT EXISTS cskh_inbox_conversations_last_msg_id_idx
  ON cskh_inbox_conversations (last_message_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS cskh_inbox_conversations_unread_tenant_idx
  ON cskh_inbox_conversations (tenant_id, last_message_at DESC, id DESC)
  WHERE unread_count > 0 OR awaiting_label = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS cskh_inbox_conversations_unread_page_idx
  ON cskh_inbox_conversations (page_id, last_message_at DESC, id DESC)
  WHERE unread_count > 0 OR awaiting_label = true;

ANALYZE cskh_inbox_conversations;
