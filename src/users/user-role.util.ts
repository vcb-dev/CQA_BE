import { User, UserRole } from '@prisma/client';

const ROLE_PRIORITY: UserRole[] = ['admin', 'manager', 'staff', 'user'];

/** Role chính từ mảng Prisma (ưu tiên admin → manager → staff → user). */
export function primaryRoleFromPrisma(roles: UserRole[]): UserRole {
  for (const role of ROLE_PRIORITY) {
    if (roles.includes(role)) return role;
  }
  return UserRole.user;
}

/** Chuẩn hóa input role → mảng UserRole Prisma khi tạo/cập nhật user. */
export function prismaRolesFromInput(role: string): UserRole[] {
  switch (role) {
    case UserRole.admin:
    case 'admin':
      return [UserRole.admin];
    case UserRole.manager:
    case 'manager':
    case 'store_manager':
      return [UserRole.manager];
    case UserRole.staff:
    case 'staff':
    case 'sales':
    case 'warehouse_staff':
    case 'purchasing':
      return [UserRole.staff];
    case UserRole.user:
    case 'user':
      return [UserRole.user];
    default:
      return [UserRole.user];
  }
}

export function parseUserId(id: string | number | bigint): bigint {
  if (typeof id === 'bigint') return id;
  return BigInt(id);
}

export function toUserIdNumber(id: bigint | number | null | undefined): number | null {
  if (id == null) return null;
  return Number(id);
}

/** Trả về user cho API — giữ field `fullName`, `phoneNumber`, `role` cho FE. */
export function toPublicUser(user: User) {
  const { passwordHash: _passwordHash, name, phone, roles, ...rest } = user;
  return {
    ...rest,
    id: Number(user.id),
    fullName: name,
    phoneNumber: phone,
    role: primaryRoleFromPrisma(roles),
  };
}
