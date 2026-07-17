/**
 * Tạo / cập nhật tài khoản user1@cqa.vn
 * Chạy: npx ts-node -r tsconfig-paths/register scripts/seed-user1.ts
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const EMAIL = 'user1@cqa.vn';
const PASSWORD = 'Vienchibao@6688';

async function main() {
  const prisma = new PrismaClient();
  try {
    const hashed = await bcrypt.hash(PASSWORD, 12);
    const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });

    const user = await prisma.user.upsert({
      where: { email: EMAIL },
      create: {
        email: EMAIL,
        name: 'User 1',
        passwordHash: hashed,
        roles: ['admin'],
        status: 'active',
        isActive: true,
        tenantId: tenant?.id ?? null,
      },
      update: {
        passwordHash: hashed,
        isActive: true,
        roles: ['admin'],
        ...(tenant?.id ? { tenantId: tenant.id } : {}),
      },
    });

    console.log(`OK: user id=${user.id} email=${user.email} tenant=${user.tenantId ?? 'none'}`);
    console.log('Đăng nhập: tài khoản user1 (hoặc user1@cqa.vn), mật khẩu đã set.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
