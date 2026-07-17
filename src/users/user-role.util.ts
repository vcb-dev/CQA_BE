import { User, UserRole as PrismaUserRole } from '@prisma/client';
import { UserRole as CqaUserRole } from './entities/user.entity';

/** Map Prisma roles → role string CQA API/JWT (tương thích FE cũ). */
export function cqaRoleFromPrisma(roles: PrismaUserRole[]): CqaUserRole {
  if (roles.includes('admin')) return CqaUserRole.ADMIN;
  if (roles.includes('store_manager')) return CqaUserRole.MANAGER;
  if (roles.includes('sales')) return CqaUserRole.STAFF;
  return CqaUserRole.USER;
}

/** Map role CQA → mảng Prisma UserRole khi tạo/cập nhật user. */
export function prismaRolesFromCqaRole(role: string): PrismaUserRole[] {
  switch (role) {
    case CqaUserRole.ADMIN:
    case 'admin':
      return ['admin'];
    case CqaUserRole.MANAGER:
    case 'manager':
      return ['store_manager'];
    case CqaUserRole.STAFF:
    case 'staff':
      return ['sales'];
    default:
      return ['sales'];
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

/** Trả về user cho API — giữ field `fullName`, `phoneNumber`, `role` cho FE cũ. */
export function toPublicUser(user: User) {
  const { passwordHash: _passwordHash, name, phone, roles, ...rest } = user;
  return {
    ...rest,
    id: Number(user.id),
    fullName: name,
    phoneNumber: phone,
    role: cqaRoleFromPrisma(roles),
  };
}
