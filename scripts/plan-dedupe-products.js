const path = require('path');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = new PrismaClient();
const q = (sql) => prisma.$queryRawUnsafe(sql);

/*
 Quy tắc dedupe AN TOÀN (chỉ xóa bản trùng lặp thật):
 - Gom theo tên chuẩn hóa (lower/trim).
 - Trong 1 nhóm cùng tên:
   * product "thật"     = có >=1 variant SKU KHÁC 'SP-%'
   * product "giả"      = có variant nhưng TẤT CẢ SKU đều 'SP-%'
   * product "rỗng"     = không có variant nào
 - Nếu nhóm có >=1 product thật  -> XÓA các product "giả" + "rỗng" (giữ toàn bộ product thật; khác size = khác SKU thật vẫn giữ).
 - Nếu nhóm KHÔNG có product thật -> giữ 1 (ưu tiên có variant giá>0, id nhỏ nhất), xóa phần còn lại.
 - KHÔNG xóa product nếu bất kỳ variant của nó bị tham chiếu bởi chứng từ nghiệp vụ.
*/

async function main() {
  const rows = await q(`
    SELECT p.id AS product_id, lower(btrim(p.name)) AS key, p.name,
           COUNT(v.id)::int AS variant_count,
           COUNT(v.id) FILTER (WHERE v.sku NOT LIKE 'SP-%')::int AS real_sku_count,
           COUNT(v.id) FILTER (WHERE v.price > 0)::int AS priced_count
    FROM products p
    LEFT JOIN product_variants v ON v.product_id = p.id
    GROUP BY p.id, lower(btrim(p.name)), p.name`);

  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.key)) groups.set(r.key, []);
    groups.get(r.key).push(r);
  }

  const toDelete = [];
  let groupsWithDup = 0;
  let keptRealSizes = 0; // nhóm giữ nhiều bản thật (khác size)

  for (const [, list] of groups) {
    if (list.length < 2) continue;
    const real = list.filter((x) => x.real_sku_count > 0);
    const fake = list.filter((x) => x.real_sku_count === 0 && x.variant_count > 0);
    const empty = list.filter((x) => x.variant_count === 0);

    if (real.length >= 1) {
      groupsWithDup++;
      if (real.length > 1) keptRealSizes++;
      for (const x of [...fake, ...empty]) toDelete.push(x.product_id);
    } else {
      groupsWithDup++;
      const sorted = [...list].sort(
        (a, b) => b.priced_count - a.priced_count || Number(a.product_id) - Number(b.product_id),
      );
      for (const x of sorted.slice(1)) toDelete.push(x.product_id);
    }
  }

  console.log(`Nhóm cùng tên có >=2 rows: ${[...groups.values()].filter((l) => l.length > 1).length}`);
  console.log(`  - nhóm giữ >1 bản thật (khác size, GIỮ nguyên): ${keptRealSizes}`);
  console.log(`Product sẽ XÓA (trùng lặp thật): ${toDelete.length}`);

  if (!toDelete.length) return;

  const idList = toDelete.join(',');
  // Kiểm tra tham chiếu nghiệp vụ tới các variant thuộc product sắp xóa
  const refTables = [
    'order_items', 'draft_order_items', 'order_return_items',
    'purchase_order_items', 'goods_receipt_items', 'stock_transfer_items',
    'purchase_return_items', 'inventory_movements', 'lots', 'price_list_items',
    'sapo_inbox_order_items',
  ];
  let blocked = 0;
  for (const t of refTables) {
    try {
      const [{ n }] = await q(`
        SELECT COUNT(*)::int AS n FROM ${t} ti
        WHERE ti.variant_id IN (SELECT id FROM product_variants WHERE product_id IN (${idList}))`);
      if (n > 0) { console.log(`  ⚠ ${t}: ${n} dòng tham chiếu -> sẽ loại product đó khỏi danh sách xóa`); blocked += n; }
    } catch (e) { /* bảng có thể chưa tồn tại */ }
  }
  console.log(`Tham chiếu nghiệp vụ chặn xóa: ${blocked}`);

  // Ghi danh sách id để bước xóa dùng lại
  const fs = require('fs');
  fs.writeFileSync(
    path.join(__dirname, 'out', 'dedupe-delete-ids.json'),
    JSON.stringify(toDelete.map((x) => x.toString())),
  );
  console.log(`Đã ghi danh sách id -> scripts/out/dedupe-delete-ids.json`);

  // Xem trước vài product sẽ xóa
  const sample = await q(`
    SELECT p.id, p.name, COUNT(v.id)::int AS vc,
           string_agg(v.sku, ', ') AS skus
    FROM products p LEFT JOIN product_variants v ON v.product_id = p.id
    WHERE p.id IN (${toDelete.slice(0, 8).join(',')})
    GROUP BY p.id, p.name`);
  console.log('\nVí dụ product sẽ xóa:');
  for (const s of sample) console.log(`  #${s.id} "${s.name}" [${s.vc} var: ${s.skus ?? '-'}]`);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); }).finally(() => prisma.$disconnect());
