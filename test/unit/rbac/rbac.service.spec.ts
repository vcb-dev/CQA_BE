import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RbacService } from '../../../src/rbac/rbac.service';
import { RbacController } from '../../../src/rbac/rbac.controller';
import { RolesGuard } from '../../../src/common/guards/roles.guard';
import { JwtAuthGuard } from '../../../src/common/guards/jwt-auth.guard';

const users = [
  { id: 1n, name: 'Bùi Duy Cường', email: 'cuong@vienchibao.com', roles: ['admin'], avatarUrl: null },
  { id: 2n, name: 'Lê Thảo Vy', email: 'vylt@vienchibao.com', roles: ['purchasing'], avatarUrl: null },
  { id: 3n, name: 'Trần Minh Quân', email: 'quantm@vienchibao.com', roles: [], avatarUrl: null },
];

const makePrisma = () => ({
  user: {
    findMany: jest.fn().mockResolvedValue(users),
    findUnique: jest.fn().mockResolvedValue({ id: 2n }),
    update: jest.fn().mockResolvedValue({ id: 2n }),
  },
});
const makeActivity = (map = new Map<string, string>()) => ({
  getActiveMap: jest.fn().mockResolvedValue(map),
});

describe('RbacService', () => {
  it('listRoles trả 4 vai trò + userCount', async () => {
    const svc = new RbacService(makePrisma() as never, makeActivity() as never);
    const roles = await svc.listRoles();
    expect(roles.map((r) => r.code)).toEqual(['admin', 'manager', 'auditor', 'agent']);
    expect(Object.fromEntries(roles.map((r) => [r.code, r.userCount]))).toEqual({
      admin: 1,
      manager: 0,
      auditor: 1,
      agent: 1,
    });
  });

  it('listUsers gộp role + lastActiveAt', async () => {
    const map = new Map([['1', '2026-09-10T03:00:00.000Z']]);
    const svc = new RbacService(makePrisma() as never, makeActivity(map) as never);
    const rows = await svc.listUsers();
    expect(rows[0]).toMatchObject({
      id: 1,
      fullName: 'Bùi Duy Cường',
      role: 'admin',
      roleLabel: 'Admin',
      permissionSummary: 'Toàn bộ hệ thống, chỉnh sửa tiêu chí & API',
      lastActiveAt: '2026-09-10T03:00:00.000Z',
    });
    expect(rows[1]).toMatchObject({ id: 2, role: 'auditor', lastActiveAt: null });
    expect(rows[2]).toMatchObject({ id: 3, role: 'agent' });
  });

  it('assignRole map role → update users.roles bằng { set }', async () => {
    const prisma = makePrisma();
    const svc = new RbacService(prisma as never, makeActivity() as never);
    const out = await svc.assignRole('2', 'manager');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 2n },
      data: { roles: { set: ['store_manager'] } },
    });
    expect(out).toEqual({ id: 2, role: 'manager' });
  });

  it('assignRole: id không phải số → BadRequestException', async () => {
    const svc = new RbacService(makePrisma() as never, makeActivity() as never);
    await expect(svc.assignRole('abc', 'manager')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('assignRole: user không tồn tại → NotFoundException', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const svc = new RbacService(prisma as never, makeActivity() as never);
    await expect(svc.assignRole('999', 'manager')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('RbacController (wiring)', () => {
  it('route trả về đúng envelope { success, data }', async () => {
    const rbac = {
      listRoles: jest.fn().mockResolvedValue([{ code: 'admin' }]),
      listUsers: jest.fn().mockResolvedValue([{ id: 1 }]),
      assignRole: jest.fn().mockResolvedValue({ id: 1, role: 'manager' }),
    };
    const mod = await Test.createTestingModule({
      controllers: [RbacController],
      providers: [{ provide: RbacService, useValue: rbac }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const ctrl = mod.get(RbacController);
    expect(await ctrl.roles()).toEqual({ success: true, data: [{ code: 'admin' }] });
    expect(await ctrl.assignRole('1', { role: 'manager' } as never)).toEqual({
      success: true,
      message: 'Cập nhật vai trò thành công',
      data: { id: 1, role: 'manager' },
    });
  });
});
