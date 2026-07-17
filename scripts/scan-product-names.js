const path = require('path');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = new PrismaClient();

function dbHost() {
  const url = process.env.DATABASE_URL || '';
  const m = url.match(/@([^/:]+)/);
  return m ? m[1] : '(unknown)';
}

async function main() {
  console.log('DB host:', dbHost());

  // 1) Xác nhận cột mới đã tồn tại + đã có dữ liệu
  const cols = await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'products' ORDER BY ordinal_position`,
  );
  console.log('\nCột bảng products:', cols.map((c) => c.column_name).join(', '));

  const total = await prisma.product.count();
  const withCat = await prisma.product.count({ where: { category: { not: null } } });
  console.log(`\nTổng: ${total} · có category: ${withCat}`);

  // 2) Quét tiền tố trong ngoặc ở đầu name
  const rows = await prisma.product.findMany({ select: { name: true } });
  const prefixFreq = new Map();
  const anyParenFreq = new Map();
  let withLeadingParen = 0;
  for (const { name } of rows) {
    const n = (name || '').trim();
    // tất cả cụm (...) bất kỳ
    for (const m of n.matchAll(/\(([^)]*)\)/g)) {
      const key = m[1].trim();
      anyParenFreq.set(key, (anyParenFreq.get(key) || 0) + 1);
    }
    // tiền tố (...) ở đầu tên
    const lead = n.match(/^\s*\(([^)]*)\)/);
    if (lead) {
      withLeadingParen++;
      const key = lead[1].trim();
      prefixFreq.set(key, (prefixFreq.get(key) || 0) + 1);
    }
  }

  const top = (map, n = 40) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  console.log(`\n--- Tiền tố (…) ở ĐẦU name (${withLeadingParen} SP) ---`);
  for (const [k, v] of top(prefixFreq)) console.log(`  ${String(v).padStart(4)}  (${k})`);

  console.log(`\n--- Mọi cụm (…) trong name ---`);
  for (const [k, v] of top(anyParenFreq)) console.log(`  ${String(v).padStart(4)}  (${k})`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); }).finally(() => prisma.$disconnect());
