const path = require('path');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = new PrismaClient();

const KNOWN = /^\s*\((\s*(chế|chể|che|thiết|thiet|mẫu|mau|dừng|dung)\b)/i;

async function main() {
  const rows = await prisma.product.findMany({ select: { name: true } });
  const remaining = rows.filter((r) => KNOWN.test(r.name || '')).map((r) => r.name);

  const craft = await prisma.product.groupBy({
    by: ['craftType'], _count: { _all: true }, orderBy: { _count: { craftType: 'desc' } },
  });
  const disc = await prisma.product.count({ where: { isDiscontinued: true } });

  console.log('craft_type:');
  for (const c of craft) console.log(`  ${(c.craftType ?? '(null)').padEnd(12)} ${c._count._all}`);
  console.log(`is_discontinued = true: ${disc}`);
  console.log(`\nName còn tiền tố marker chưa tách: ${remaining.length}`);
  remaining.slice(0, 20).forEach((n) => console.log('  ! ' + n));
}
main().catch((e) => { console.error(e.message || e); process.exit(1); }).finally(() => prisma.$disconnect());
