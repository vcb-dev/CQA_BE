# Schema tổng Warehouse + CQA CRM

Hai backend dùng **cùng một PostgreSQL** qua schema này (union đầy đủ của cả hai).

## Schema owner

- **Canonical:** `Multi-warehouse-management_be/prisma/schema.prisma`
- **Mirror:** `CQA_CRM/CQA_BE/prisma/schema.prisma` (copy giống hệt)

Migration history nằm ở `prisma/migrations` (đồng bộ giữa Warehouse + CQA).

**CI/CD CQA:** mỗi lần deploy `main` → GitHub Actions chạy `prisma migrate deploy`, container API cũng chạy migrate khi start. Không cần migrate tay.

Khi đổi schema: `npx prisma migrate dev --name ...` → commit folder migration → push.

## Merge rules (tóm tắt)

1. Giữ **tất cả** model/enum từ cả hai schema — không drop gì.
2. Model trùng nhau: **union fields**; ưu tiên Warehouse cho domain kho (PO/GR/Transfer/Ledger/Refund), ưu tiên CQA cho CRM/Sapo/inbox/Lot.
3. Enum: union toàn bộ giá trị (vd. `MovementType`, `GoodsReceiptStatus.huy`, `PaymentStatus.mot_phan`, `StockTransferStatus.nhap|cho_chuyen`).
4. Relations hai chiều phải khớp (Lot ↔ ProductVariant/movements/items; SapoInboxOrderItem ↔ ProductVariant; User ↔ ledger).
5. Indexes: union; giữ indexes Warehouse trên `purchase_orders` / `goods_receipts` / orders.
6. Header: `// Prisma schema tổng — Warehouse + CQA CRM (shared database)`
7. Giữ `directUrl = env("DIRECT_URL")`
8. Không invent bảng mới ngoài hai schema gốc.

## Models thêm từ mỗi phía (so với phía kia trước merge)

| Nguồn | Models / enums chỉ có ở phía đó |
|---|---|
| **CQA only → giữ** | `Lot`, `SapoCatalogVariant`, `SapoInboxOrder`, `SapoInboxOrderItem` |
| **Warehouse only → giữ** | `RefundStatus`, `SupplierLedgerReferenceType`, `SupplierLedgerEntry`, `CustomerLedgerReferenceType`, `CustomerLedgerEntry` |

## Conflicts đã resolve

| Conflict | Resolution |
|---|---|
| `GoodsReceiptItem.lotId` (CQA required) vs `purchaseOrderId` (Warehouse) | **Union:** `purchaseOrderId BigInt?` + `lotId BigInt?` (optional) — Warehouse rows không lot vẫn OK; CQA vẫn gắn lot khi có |
| `StockTransferItem` / `PurchaseReturnItem` lot | `lotId BigInt?` optional + relation `Lot?` |
| `MovementType` | Union: giữ CQA base + Warehouse `incoming_transfer`, `transfer_reserve`, `transfer_release` |
| `GoodsReceiptStatus` / `PaymentStatus` / `StockTransferStatus` | Warehouse expanded (`huy`, `mot_phan`, `nhap`, `cho_chuyen`) |
| `Product` Sapo/CRM fields | Thêm từ CQA: `sapoId`, `category`, `material`, `craftType`, `isDiscontinued`, `publishedAt`, `sapoCreatedAt`, `sapoUpdatedAt`, `@@index([category, material])` |
| `ProductVariant` | CQA `title`/`unit`/`lots`/`sapoInboxItems` + Warehouse `@@index([productId])` |
| `CskhInboxMessage` / Conversation | CQA translation: `originalText`, `translatedText`, `sourceLang`; conversation `customerLang`, `customerLangLabel` |
| PO/GR/Transfer/Return/Order money fields | Warehouse: `depositAmount`, `paidAmount`, `depositApplied`, `invoiceSymbol`, `refundStatus`, `shippedAt`, indexes |
| Indexes trên join tables | Union (giữ Warehouse `@@index` trên variant/option/category/warehouse/order items) |

## User thống nhất

| CQA cũ | Schema mới |
|---|---|
| `fullName` | `name` |
| `password` | `passwordHash` |
| `phoneNumber` | `phone` |
| `role` (string) | `roles` (UserRole[]) |
| `id` Int | `id` BigInt |
| — | `tenantId`, `avatarUrl`, `status`, `updatedAt` |

API CQA vẫn trả `fullName`, `phoneNumber`, `role` qua helper `toPublicUser()`.

## Migrate DB (không mất data CQA)

### Trường hợp A — DB CQA Supabase đang có data

1. Backup database trước.
2. Thêm `DIRECT_URL` (port 5432) vào `.env` cả hai project.
3. Trên Warehouse BE:

```bash
cd Multi-warehouse-management_be
npx prisma migrate deploy
```

Migration merge sẽ:
- Align `users` (password_hash, name, BigInt id, …) nếu cần
- Tạo bảng Warehouse / Lot / Sapo / Ledger chưa có
- Giữ data CQA (`tenants`, `cskh_*`, `chat_audits`, Sapo inbox)

### Trường hợp B — DB Warehouse mới (chưa có CQA)

```bash
npx prisma migrate deploy
npx prisma db seed   # nếu cần seed kho
```

### Sau migrate

```bash
# Warehouse BE
npx prisma generate

# CQA BE
cd CQA_CRM/CQA_BE
npx prisma generate
npm run build
```

## Env chung

```env
DATABASE_URL=postgresql://...@...supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://...@...supabase.com:5432/postgres
```

Cả hai BE trỏ cùng `DATABASE_URL` / `DIRECT_URL`.

## Validate

```bash
# Cả hai project phải pass:
npx prisma validate
```
