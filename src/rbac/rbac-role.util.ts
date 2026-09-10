import { UserRole as PrismaUserRole } from '@prisma/client';

/** 4 vai trò của trang "Phân quyền" CQA. Không liên quan enum UserRole của DB. */
export type CqaRbacRole = 'admin' | 'manager' | 'auditor' | 'agent';

export const CQA_RBAC_ROLES: CqaRbacRole[] = ['admin', 'manager', 'auditor', 'agent'];

/** Vai trò RBAC → giá trị lưu ở cột users.roles (không thêm giá trị enum mới). */
const RBAC_TO_PRISMA: Record<CqaRbacRole, PrismaUserRole> = {
  admin: 'admin',
  manager: 'store_manager',
  auditor: 'purchasing',
  agent: 'sales',
};

export function prismaRolesFromRbacRole(role: CqaRbacRole): PrismaUserRole[] {
  return [RBAC_TO_PRISMA[role]];
}

/** Đọc vai trò RBAC từ mảng users.roles. Ưu tiên cao → thấp; rỗng/khác → agent. */
export function rbacRoleFromPrisma(
  roles: PrismaUserRole[] | null | undefined,
): CqaRbacRole {
  const set = new Set(roles ?? []);
  if (set.has('admin')) return 'admin';
  if (set.has('store_manager')) return 'manager';
  if (set.has('purchasing')) return 'auditor';
  return 'agent';
}
