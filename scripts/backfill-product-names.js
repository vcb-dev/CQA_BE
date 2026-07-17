/**
 * Tách tiền tố trong name (VD "(CHẾ TÁC)", "(Dừng bán)") thành craft_type + is_discontinued,
 * đồng thời làm sạch name. Chạy trên dữ liệu products hiện có (không gọi Sapo).
 * Chạy: node scripts/backfill-product-names.js
 */
const path = require('path');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = new PrismaClient();

const CRAFT_TYPE_MAP = { 'che tac': 'Chế tác', 'thiet ke': 'Thiết kế', mau: 'Mẫu' };

function markerKey(value) {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

function extractNameMarkers(rawName) {
  let name = (rawName || '').replace(/^[\s\p{M}]+/u, '').trim();
  let craftType = null;
  let isDiscontinued = false;
  const leading = /^[\s\p{M}]*\(([^)]*)\)\s*[-–:]?\s*/u;
  for (let guard = 0; guard < 5; guard++) {
    const m = name.match(leading);
    if (!m) break;
    const key = markerKey(m[1]);
    if (CRAFT_TYPE_MAP[key]) {
      craftType = craftType || CRAFT_TYPE_MAP[key];
      name = name.slice(m[0].length).trim();
      continue;
    }
    if (key.startsWith('dung')) {
      isDiscontinued = true;
      name = name.slice(m[0].length).trim();
      continue;
    }
    break;
  }
  name = name.replace(/^[\s\p{M}]+/u, '').trim();
  return { name: name || (rawName || '').trim(), craftType, isDiscontinued };
}

async function main() {
  // Đảm bảo cột tồn tại (idempotent)
  await prisma.$executeRawUnsafe(`ALTER TABLE products ADD COLUMN IF NOT EXISTS craft_type TEXT`);
  await prisma.$executeRawUnsafe(
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS is_discontinued BOOLEAN NOT NULL DEFAULT FALSE`,
  );

  const rows = await prisma.product.findMany({ select: { id: true, name: true } });
  let craft = 0;
  let discontinued = 0;
  const samples = [];
  const changes = [];

  for (const r of rows) {
    const { name, craftType, isDiscontinued } = extractNameMarkers(r.name);
    if (name === r.name && craftType == null && !isDiscontinued) continue;
    changes.push({ id: r.id, name, craftType, isDiscontinued });
    if (craftType) craft++;
    if (isDiscontinued) discontinued++;
    if (samples.length < 12 && name !== r.name) {
      samples.push({ before: r.name, after: name, craftType, isDiscontinued });
    }
  }

  const q = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
  const CHUNK = 300;
  for (let i = 0; i < changes.length; i += CHUNK) {
    const batch = changes.slice(i, i + CHUNK);
    const values = batch
      .map((c) => `(${c.id}::bigint, ${q(c.name)}, ${q(c.craftType)}, ${c.isDiscontinued})`)
      .join(',');
    await prisma.$executeRawUnsafe(
      `UPDATE products AS p
         SET name = v.name, craft_type = v.craft_type, is_discontinued = v.is_discontinued
       FROM (VALUES ${values}) AS v(id, name, craft_type, is_discontinued)
       WHERE p.id = v.id`,
    );
    console.log(`  ...cập nhật ${Math.min(i + CHUNK, changes.length)}/${changes.length}`);
  }
  const updated = changes.length;

  console.log(`\n=== BACKFILL NAME ===`);
  console.log(`Đã cập nhật: ${updated} / ${rows.length} SP`);
  console.log(`  craft_type:      ${craft}`);
  console.log(`  is_discontinued: ${discontinued}`);
  console.log('\nVí dụ làm sạch name:');
  for (const s of samples) {
    console.log(`  "${s.before}"`);
    console.log(`   → "${s.after}"  [craft=${s.craftType ?? '-'}, dừng=${s.isDiscontinued}]`);
  }
}

main().catch((e) => { console.error('❌', e.message || e); process.exit(1); }).finally(() => prisma.$disconnect());
