-- Restore the tenant list index dropped when needs_reply was added.
CREATE INDEX IF NOT EXISTS "cskh_inbox_conversations_tenant_id_last_message_at_id_idx"
  ON "cskh_inbox_conversations"("tenant_id", "last_message_at" DESC, "id" DESC);

-- Last message from the customer means the thread still needs a reply.
SET LOCAL statement_timeout = 0;
UPDATE "cskh_inbox_conversations" c
SET "needs_reply" = TRUE
FROM (
  SELECT DISTINCT ON (m.conversation_id)
    m.conversation_id,
    m.sender_type,
    m.direction
  FROM "cskh_inbox_messages" m
  ORDER BY m.conversation_id, m.sent_at DESC
) last
WHERE c.id = last.conversation_id
  AND NOT (last.sender_type = 'staff' OR last.direction = 'outbound');
