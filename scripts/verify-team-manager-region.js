// Chạy tay 1 lần: node scripts/verify-team-manager-region.js
// Chỉ SELECT — kiểm tra migration team/manager_name/region đã có trên DB thật
// chưa, và in ra các page đã có team/managerName/region (nếu apply script đã chạy).
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  const rows = await prisma.facebookCskhConfig.findMany({
    select: {
      pageId: true,
      pageName: true,
      enabled: true,
      team: true,
      managerName: true,
      region: true,
    },
    orderBy: { pageName: 'asc' },
  });
  const withInfo = rows.filter((r) => r.team || r.managerName || r.region);
  console.log(
    `Tổng ${rows.length} page. Đã có team/manager/region: ${withInfo.length}.`,
  );
  console.log(JSON.stringify(withInfo, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
