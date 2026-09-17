import { UserRole } from '@prisma/client';

/** Định nghĩa tĩnh 1 vai trò — dùng cho cột "Vai trò" + "Quyền chính" của FE. */
export interface RbacRoleDef {
  code: UserRole;
  label: string;
  /** Cột "Quyền chính" — 1 dòng, nguyên văn mockup. */
  description: string;
  /** Danh sách khả năng, hiển thị chi tiết khi cần. */
  permissions: string[];
}

export const RBAC_CATALOG: RbacRoleDef[] = [
  {
    code: UserRole.admin,
    label: 'Admin',
    description: 'Toàn bộ hệ thống, chỉnh sửa tiêu chí & API',
    permissions: [
      'Toàn quyền quản trị hệ thống',
      'Chỉnh sửa tiêu chí & cấu hình AI chấm điểm',
      'Quản lý kết nối API & kênh',
      'Phân quyền người dùng',
    ],
  },
  {
    code: UserRole.manager,
    label: 'Manager',
    description: 'Xem báo cáo, phê duyệt audit nháp',
    permissions: [
      'Xem toàn bộ báo cáo & dashboard',
      'Phê duyệt audit nháp',
      'Quản lý & đánh giá nhân viên',
    ],
  },
  {
    code: UserRole.staff,
    label: 'Staff',
    description: 'Chấm điểm thủ công, đánh giá phụ',
    permissions: [
      'Chấm điểm hội thoại thủ công',
      'Đánh giá phụ (second review)',
      'Xem hội thoại được giao',
    ],
  },
  {
    code: UserRole.user,
    label: 'User',
    description: 'Chỉ xem điểm cá nhân và chat khách hàng',
    permissions: [
      'Xem điểm & nhận xét cá nhân',
      'Chat với khách hàng',
      'Xem hội thoại của mình',
    ],
  },
];

/** Danh sách mã vai trò — dùng cho DTO, suy ra từ RBAC_CATALOG để không lệch. */
export const RBAC_ROLE_CODES: UserRole[] = RBAC_CATALOG.map((r) => r.code);

export const RBAC_CATALOG_BY_CODE = Object.fromEntries(
  RBAC_CATALOG.map((r) => [r.code, r]),
) as Record<UserRole, RbacRoleDef>;
