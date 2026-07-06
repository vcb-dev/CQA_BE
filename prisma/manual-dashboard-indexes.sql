-- Tăng tốc COUNT dashboard (chạy 1 lần trên Postgres production)
CREATE INDEX CONCURRENTLY IF NOT EXISTS cskh_inbox_messages_tenant_id_idx
  ON cskh_inbox_messages (tenant_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS chat_audits_tenant_id_idx
  ON chat_audits (tenant_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS chat_audits_tenant_id_created_at_idx
  ON chat_audits (tenant_id, created_at DESC);
