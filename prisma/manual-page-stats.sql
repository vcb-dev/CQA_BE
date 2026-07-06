-- Tổng hợp tin nhắn theo Page — màn Page/Kênh đọc bảng này thay vì COUNT 300k+ tin mỗi lần.
-- Chạy trên Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS "cskh_page_message_totals" (
  "page_id" TEXT PRIMARY KEY,
  "message_count" BIGINT NOT NULL DEFAULT 0,
  "conversation_count" BIGINT NOT NULL DEFAULT 0,
  "unread_conversation_count" BIGINT NOT NULL DEFAULT 0,
  "refreshed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "cskh_page_message_totals_refreshed_at_idx"
  ON "cskh_page_message_totals" ("refreshed_at");

-- groupBy page_id trên conversations
CREATE INDEX IF NOT EXISTS "cskh_inbox_conversations_page_id_only_idx"
  ON "cskh_inbox_conversations" ("page_id");

-- Thống kê inbound theo ngày: lọc sent_at rồi join conversation
CREATE INDEX IF NOT EXISTS "cskh_inbox_messages_sent_at_conversation_id_idx"
  ON "cskh_inbox_messages" ("sent_at", "conversation_id");

-- Lần đầu / refresh toàn bộ (chạy 1 lần, có thể mất vài phút)
INSERT INTO "cskh_page_message_totals" (
  "page_id", "message_count", "conversation_count", "unread_conversation_count", "refreshed_at"
)
SELECT
  c.page_id,
  COUNT(m.id)::bigint,
  COUNT(DISTINCT c.id)::bigint,
  COUNT(DISTINCT c.id) FILTER (WHERE c.unread_count > 0)::bigint,
  NOW()
FROM cskh_inbox_conversations c
LEFT JOIN cskh_inbox_messages m ON m.conversation_id = c.id
GROUP BY c.page_id
ON CONFLICT ("page_id") DO UPDATE SET
  message_count = EXCLUDED.message_count,
  conversation_count = EXCLUDED.conversation_count,
  unread_conversation_count = EXCLUDED.unread_conversation_count,
  refreshed_at = EXCLUDED.refreshed_at;
