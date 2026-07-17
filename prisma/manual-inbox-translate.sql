-- Dịch tin nhắn inbox — chạy trên Supabase SQL Editor nếu prisma db push lỗi qua pooler
ALTER TABLE "cskh_inbox_conversations"
  ADD COLUMN IF NOT EXISTS "customer_lang" VARCHAR(16);
ALTER TABLE "cskh_inbox_conversations"
  ADD COLUMN IF NOT EXISTS "customer_lang_label" VARCHAR(64);

ALTER TABLE "cskh_inbox_messages"
  ADD COLUMN IF NOT EXISTS "original_text" TEXT;
ALTER TABLE "cskh_inbox_messages"
  ADD COLUMN IF NOT EXISTS "translated_text" TEXT;
ALTER TABLE "cskh_inbox_messages"
  ADD COLUMN IF NOT EXISTS "source_lang" VARCHAR(16);
