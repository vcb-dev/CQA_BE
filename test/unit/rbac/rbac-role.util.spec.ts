import {
  prismaRolesFromRbacRole,
  rbacRoleFromPrisma,
  CQA_RBAC_ROLES,
} from '../../../src/rbac/rbac-role.util';
import { RBAC_CATALOG, RBAC_CATALOG_BY_CODE } from '../../../src/rbac/rbac.catalog';

describe('rbac-role.util', () => {
  it('CQA_RBAC_ROLES đúng 4 vai trò theo thứ tự', () => {
    expect(CQA_RBAC_ROLES).toEqual(['admin', 'manager', 'auditor', 'agent']);
  });

  it('prismaRolesFromRbacRole map đúng giá trị enum', () => {
    expect(prismaRolesFromRbacRole('admin')).toEqual(['admin']);
    expect(prismaRolesFromRbacRole('manager')).toEqual(['store_manager']);
    expect(prismaRolesFromRbacRole('auditor')).toEqual(['purchasing']);
    expect(prismaRolesFromRbacRole('agent')).toEqual(['sales']);
  });

  it('rbacRoleFromPrisma ưu tiên admin > manager > auditor, còn lại agent', () => {
    expect(rbacRoleFromPrisma(['admin'])).toBe('admin');
    expect(rbacRoleFromPrisma(['store_manager'])).toBe('manager');
    expect(rbacRoleFromPrisma(['purchasing'])).toBe('auditor');
    expect(rbacRoleFromPrisma(['sales'])).toBe('agent');
    expect(rbacRoleFromPrisma([])).toBe('agent');
    expect(rbacRoleFromPrisma(null)).toBe('agent');
    expect(rbacRoleFromPrisma(['admin', 'sales'])).toBe('admin');
  });

  it('RBAC_CATALOG có 4 def, description khớp mockup', () => {
    expect(RBAC_CATALOG.map((r) => r.code)).toEqual(['admin', 'manager', 'auditor', 'agent']);
    expect(RBAC_CATALOG_BY_CODE.admin.description).toBe('Toàn bộ hệ thống, chỉnh sửa tiêu chí & API');
    expect(RBAC_CATALOG_BY_CODE.agent.description).toBe('Chỉ xem điểm cá nhân và chat khách hàng');
    for (const def of RBAC_CATALOG) {
      expect(def.permissions.length).toBeGreaterThan(0);
      expect(def.label.length).toBeGreaterThan(0);
    }
  });
});
