// Chạy tay, SAU KHI migration đã deploy lên DB thật (bảng facebook_cskh_configs
// đã có cột team/manager_name/region). Đối chiếu file Google Sheet
// "Tong_hop_kenh_theo_team" (tất cả tab: ADS, Team K0-K5, Team Đồ Da,
// Global - Mỹ/JP1/Thái) với danh sách page thật trong DB — 58 dòng đủ
// bằng chứng chắc chắn (khớp ID/Username, URL, hoặc fuzzy-match lỗi chính
// tả/emoji đã xác nhận tay — luôn khớp đúng nền tảng FB/IG). Xem chi tiết +
// các dòng chưa xử lý trong file CQA_DOCS/kenh-toan-bo-doi-chieu-db.xlsx.
//
//   node scripts/apply-team-manager-region-all.js         → chạy thật
//   node scripts/apply-team-manager-region-all.js --dry    → chỉ in ra, không ghi DB
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const UPDATES = [
  {
    pageId: '313549675173899',
    managerName: 'Nguyễn Linh Chi',
    region: 'Việt Nam',
    team: 'Team K0',
  },
  {
    pageId: '959755663877523',
    managerName: 'Nguyễn Bá Tuấn Anh',
    region: 'Việt Nam',
    team: 'Team K0',
  },
  {
    pageId: '2119298598397029',
    managerName: 'Nguyễn Lê Thùy An',
    region: 'Việt Nam',
    team: 'Team K1',
  },
  {
    pageId: '574902209045081',
    managerName: 'Nguyễn Lê Thùy An',
    region: 'Việt Nam',
    team: 'Team K1',
  },
  {
    pageId: '968743346311554',
    managerName: 'Nguyễn Thăng Đỗ Tuấn',
    region: 'Việt Nam',
    team: 'Team K1',
  },
  {
    pageId: '17841479194993544',
    managerName: 'Nguyễn Thăng Đỗ Tuấn',
    region: 'Việt Nam',
    team: 'Team K1',
  },
  {
    pageId: '361934747012477',
    managerName: 'Đỗ Thị Nga',
    region: 'Việt Nam',
    team: 'Team K1',
  },
  {
    pageId: '17841470107944775',
    managerName: 'Đỗ Thị Nga',
    region: 'Việt Nam',
    team: 'Team K1',
  },
  {
    pageId: '918762477988552',
    managerName: 'Nguyễn Thị Thảo Vi',
    region: 'Việt Nam',
    team: 'Team K5',
  },
  {
    pageId: '458542740676011',
    managerName: 'Trần Mai Linh',
    region: 'Việt Nam',
    team: 'Team K5',
  },
  {
    pageId: '17841470089440008',
    managerName: 'Trần Mai Linh',
    region: 'Việt Nam',
    team: 'Team K5',
  },
  {
    pageId: '960902163769375',
    managerName: 'Lê Quý Đôn',
    region: 'Việt Nam',
    team: 'Team K5',
  },
  {
    pageId: '891120890753783',
    managerName: 'Trần Mai Linh',
    region: 'Việt Nam',
    team: 'Team K5',
  },
  {
    pageId: '817295311471843',
    managerName: 'Lê Đình Anh Tuấn',
    region: 'Việt Nam',
    team: 'Team K5',
  },
  {
    pageId: '811176188744650',
    managerName: 'Bùi Minh Quyết',
    region: 'Việt Nam',
    team: 'Team K2',
  },
  {
    pageId: '392809170592147',
    managerName: 'Bùi Đoàn',
    region: 'Việt Nam',
    team: 'Team K2',
  },
  {
    pageId: '17841470293824226',
    managerName: 'Bùi Đoàn',
    region: 'Việt Nam',
    team: 'Team K2',
  },
  {
    pageId: '914761368386698',
    managerName: 'Huyền Trang',
    region: 'Việt Nam',
    team: 'Team K2',
  },
  {
    pageId: '17841478721507157',
    managerName: 'Huyền Trang',
    region: 'Việt Nam',
    team: 'Team K2',
  },
  {
    pageId: '443064908892493',
    managerName: 'Nguyễn Vân',
    region: 'Việt Nam',
    team: 'Team K2',
  },
  {
    pageId: '17841469826644640',
    managerName: 'Nguyễn Vân',
    region: 'Việt Nam',
    team: 'Team K2',
  },
  {
    pageId: '232496739957126',
    managerName: 'Quý An',
    region: 'Việt Nam',
    team: 'Team K2',
  },
  {
    pageId: '673915945811644',
    managerName: 'Đặng Văn Trọng',
    region: 'Việt Nam',
    team: 'Team K2',
  },
  {
    pageId: '17841423556993899',
    managerName: 'Đặng Văn Trọng',
    region: 'Việt Nam',
    team: 'Team K2',
  },
  {
    pageId: '1010405292165770',
    managerName: 'Ma Thị Hạnh',
    region: 'Việt Nam',
    team: 'Team K3',
  },
  {
    pageId: '2497800676910664',
    managerName: 'Nguyễn Thị Ánh',
    region: 'Việt Nam',
    team: 'Team K3',
  },
  {
    pageId: '17841470726320103',
    managerName: 'Nguyễn Thị Ánh',
    region: 'Việt Nam',
    team: 'Team K3',
  },
  {
    pageId: '101451428617627',
    managerName: 'Ma Thị Hạnh',
    region: 'Việt Nam',
    team: 'Team K3',
  },
  {
    pageId: '758889683984326',
    managerName: 'Phạm Trung Hiếu',
    region: 'Việt Nam',
    team: 'Team K3',
  },
  {
    pageId: '17841431690473463',
    managerName: 'Phạm Trung Hiếu',
    region: 'Việt Nam',
    team: 'Team K3',
  },
  {
    pageId: '148888379055195',
    managerName: 'Đỗ Đăng Chung',
    region: 'Việt Nam',
    team: 'Team K4',
  },
  {
    pageId: '964204583450876',
    managerName: 'Hồ Thành Đạt',
    region: 'Việt Nam',
    team: 'Team Đồ Da',
  },
  {
    pageId: '963658766819517',
    managerName: 'Trần Thắm',
    region: 'Việt Nam',
    team: 'Team Đồ Da',
  },
  {
    pageId: '999199069951717',
    managerName: 'Trần Minh Quý',
    region: 'Việt Nam',
    team: 'Team Đồ Da',
  },
  {
    pageId: '17841433989313081',
    managerName: 'Trần Minh Quý',
    region: 'Việt Nam',
    team: 'Team Đồ Da',
  },
  {
    pageId: '1002124969653345',
    managerName: 'Trần Thắm',
    region: 'Việt Nam',
    team: 'Team Đồ Da',
  },
  {
    pageId: '17841447719314199',
    managerName: 'Trần Thắm',
    region: 'Việt Nam',
    team: 'Team Đồ Da',
  },
  {
    pageId: '1024464767426019',
    managerName: 'Bùi Anh Tú',
    region: 'Mỹ',
    team: 'Global - Mỹ',
  },
  {
    pageId: '1213368331869365',
    managerName: 'Bùi Anh Tú',
    region: 'Mỹ',
    team: 'Global - Mỹ',
  },
  {
    pageId: '17841423947881935',
    managerName: 'Bùi Anh Tú',
    region: 'Mỹ',
    team: 'Global - Mỹ',
  },
  {
    pageId: '1368766746310618',
    managerName: 'Hoàng Nguyễn Tùng Huy',
    region: 'Mỹ',
    team: 'Global - Mỹ',
  },
  {
    pageId: '1139024135950924',
    managerName: 'Phan Đạt',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
  {
    pageId: '1118353961350781',
    managerName: 'Phan Đạt',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
  {
    pageId: '1006170232588923',
    managerName: 'Quốc Huy',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
  {
    pageId: '17841427824223982',
    managerName: 'Quốc Huy',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
  {
    pageId: '984873641382158',
    managerName: 'Thùy Trang',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
  {
    pageId: '1009541302242389',
    managerName: 'QUÂN',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
  {
    pageId: '1098333076690416',
    managerName: 'Nguyễn Đạt',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
  {
    pageId: '1030600786812490',
    managerName: 'Nguyễn Thùy Linh',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
  {
    pageId: '1174871125691026',
    managerName: 'Nguyễn Thùy Linh',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
  {
    pageId: '763339010200340',
    managerName: 'Trung Vũ',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
  {
    pageId: '1104669962725589',
    managerName: 'Bùi Vượng',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
  {
    pageId: '1057818037416434',
    managerName: 'Tuân',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
  {
    pageId: '940556582484873',
    managerName: 'Tuân',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
  {
    pageId: '17841414784033338',
    managerName: 'Tuân',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
  {
    pageId: '504308156109831',
    managerName: 'Phan Đạt',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
  {
    pageId: '17841479961706609',
    managerName: 'QUÂN',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
  {
    pageId: '17841476347442379',
    managerName: 'Trung Vũ',
    region: 'Thái Lan',
    team: 'Global Thái Lan',
  },
];

async function main() {
  const dryRun = process.argv.includes('--dry');
  const prisma = new PrismaClient();

  for (const u of UPDATES) {
    if (dryRun) {
      console.log(
        `[dry] ${u.pageId} -> team=${u.team}, managerName=${u.managerName}, region=${u.region}`,
      );
      continue;
    }
    const result = await prisma.facebookCskhConfig.updateMany({
      where: { pageId: u.pageId },
      data: { team: u.team, managerName: u.managerName, region: u.region },
    });
    console.log(`${u.pageId}: ${result.count} row(s) updated`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
