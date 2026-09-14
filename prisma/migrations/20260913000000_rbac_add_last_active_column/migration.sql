-- RBAC "Hoạt động cuối": chuyển lưu trữ từ Redis/bộ nhớ process sang thẳng cột DB.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_active_at" TIMESTAMP(3);
