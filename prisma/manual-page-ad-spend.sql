-- Chi tiêu QC theo Page/ngày — chạy trên Supabase SQL Editor nếu prisma db push lỗi qua pooler
CREATE TABLE IF NOT EXISTS "cskh_page_ad_spend_daily" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "cskh_page_ad_spend_daily_page_id_stat_date_key"
  ON "cskh_page_ad_spend_daily" ("page_id", "stat_date");

CREATE INDEX IF NOT EXISTS "cskh_page_ad_spend_daily_stat_date_idx"
  ON "cskh_page_ad_spend_daily" ("stat_date");

CREATE INDEX IF NOT EXISTS "cskh_page_ad_spend_daily_tenant_id_stat_date_idx"
  ON "cskh_page_ad_spend_daily" ("tenant_id", "stat_date");

-- Tăng tốc thống kê tin theo ngày trên màn Page/Kênh
CREATE INDEX IF NOT EXISTS "cskh_inbox_messages_sent_at_idx"
  ON "cskh_inbox_messages" ("sent_at" DESC);

CREATE INDEX IF NOT EXISTS "cskh_inbox_messages_direction_sent_at_idx"
  ON "cskh_inbox_messages" ("direction", "sent_at" DESC);
