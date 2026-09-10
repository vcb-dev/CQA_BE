import {
  RBAC_CATALOG,
  RBAC_CATALOG_BY_CODE,
  RBAC_ROLE_CODES,
} from '../../../src/rbac/rbac.catalog';

describe('rbac.catalog', () => {
  it('RBAC_ROLE_CODES đúng 4 vai trò theo thứ tự enum UserRole', () => {
    expect(RBAC_ROLE_CODES).toEqual(['admin', 'manager', 'staff', 'user']);
  });

  it('RBAC_CATALOG đúng thứ tự admin, manager, staff, user', () => {
    expect(RBAC_CATALOG.map((r) => r.code)).toEqual(['admin', 'manager', 'staff', 'user']);
  });

  it('description khớp nguyên văn bảng trong brief', () => {
    expect(RBAC_CATALOG_BY_CODE.admin.description).toBe(
      'Toàn bộ hệ thống, chỉnh sửa tiêu chí & API',
    );
    expect(RBAC_CATALOG_BY_CODE.manager.description).toBe(
      'Xem báo cáo, phê duyệt audit nháp',
    );
    expect(RBAC_CATALOG_BY_CODE.staff.description).toBe(
      'Chấm điểm thủ công, đánh giá phụ',
    );
    expect(RBAC_CATALOG_BY_CODE.user.description).toBe(
      'Chỉ xem điểm cá nhân và chat khách hàng',
    );
  });

  it('mọi permissions không rỗng', () => {
    for (const def of RBAC_CATALOG) {
      expect(def.permissions.length).toBeGreaterThan(0);
      expect(def.label.length).toBeGreaterThan(0);
    }
  });

  it('RBAC_CATALOG_BY_CODE có đủ 4 khóa', () => {
    expect(Object.keys(RBAC_CATALOG_BY_CODE).sort()).toEqual(
      ['admin', 'manager', 'staff', 'user'].sort(),
    );
  });
});
