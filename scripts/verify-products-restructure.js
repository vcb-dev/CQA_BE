const path = require('path');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.product.findMany({
    where: { productType: { contains: '>>' } },
    select: { id: true, name: true, brand: true, productType: true, category: true, material: true, unit: true },
    orderBy: { id: 'asc' },
    take: 10,
  });
  console.log('Trước (product_type)  →  Sau (category | material)\n');
  for (const r of rows) {
    console.log(
      `#${String(r.id).padEnd(4)} ${String(r.productType).padEnd(34)} → ` +
        `${String(r.category ?? '').padEnd(16)} | ${String(r.material ?? '').padEnd(18)} | ${r.unit ?? ''}`,
    );
  }

  const unitStats = await prisma.product.groupBy({
    by: ['unit'], _count: { _all: true }, orderBy: { _count: { unit: 'desc' } }, take: 12,
  });
  console.log('\nĐơn vị sau chuẩn hóa:');
  for (const u of unitStats) console.log(`  ${(u.unit ?? '(trống)').padEnd(12)} ${u._count._all}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); }).finally(() => prisma.$disconnect());
