import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Test } from '@nestjs/testing';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { RbacService } from '../../../src/rbac/rbac.service';
import { RbacController } from '../../../src/rbac/rbac.controller';
import { RbacModule } from '../../../src/rbac/rbac.module';
import { RbacActivityService } from '../../../src/rbac/rbac-activity.service';
import { RbacActivityInterceptor } from '../../../src/rbac/rbac-activity.interceptor';
import { RolesGuard } from '../../../src/common/guards/roles.guard';
import { JwtAuthGuard } from '../../../src/common/guards/jwt-auth.guard';
import { ROLES_KEY } from '../../../src/common/decorators/roles.decorator';

// Key metadata lấy đúng từ @nestjs/common@11 (node_modules/@nestjs/common/constants.js):
// GUARDS_METADATA = '__guards__', MODULE_METADATA.PROVIDERS = 'providers'.
// @UseGuards/@Module ghi thẳng các key này lên class bằng Reflect.defineMetadata → đọc tĩnh, không cần boot app.
const GUARDS_METADATA_KEY = '__guards__';
const MODULE_PROVIDERS_KEY = 'providers';

const users = [
  {
    id: 1n,
    name: 'Bùi Duy Cường',
    email: 'cuong@vienchibao.com',
    roles: ['admin'],
    avatarUrl: null,
  },
  {
    id: 2n,
    name: 'Lê Thảo Vy',
    email: 'vylt@vienchibao.com',
    roles: ['staff'],
    avatarUrl: null,
  },
  {
    id: 3n,
    name: 'Trần Minh Quân',
    email: 'quantm@vienchibao.com',
    roles: [],
    avatarUrl: null,
  },
  // Nhiều role cùng lúc — kiểm tra primaryRoleFromPrisma ưu tiên admin cao nhất.
  {
    id: 4n,
    name: 'Phạm Anh Tuấn',
    email: 'tuanpa@vienchibao.com',
    roles: ['staff', 'admin'],
    avatarUrl: null,
  },
];

const makePrisma = () => ({
  user: {
    findMany: jest.fn().mockResolvedValue(users),
    findUnique: jest.fn().mockResolvedValue({ id: 2n }),
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ id: 2n }),
    count: jest.fn().mockResolvedValue(users.length),
    create: jest.fn().mockResolvedValue({
      id: 9n,
      name: 'Nhân viên mới',
      email: 'moi@vienchibao.com',
      roles: ['staff'],
      avatarUrl: null,
    }),
  },
  tenant: { findFirst: jest.fn().mockResolvedValue({ id: 'tenant-uuid' }) },
});
const makeActivity = (map = new Map<string, string>()) => ({
  getActiveMap: jest.fn().mockResolvedValue(map),
});

describe('RbacService.createUser', () => {
  it('email trùng → ConflictException, không tạo gì', async () => {
    const prisma = makePrisma();
    prisma.user.findFirst.mockResolvedValue({ id: 1n });
    const svc = new RbacService(prisma as never, makeActivity() as never);
    await expect(
      svc.createUser({
        email: 'cuong@vienchibao.com',
        fullName: 'Trùng email',
        password: 'Matkhau@123',
        role: UserRole.staff,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('chuẩn hóa email, hash mật khẩu, gắn tenant và set vai trò', async () => {
    const prisma = makePrisma();
    const svc = new RbacService(prisma as never, makeActivity() as never);
    const out = await svc.createUser({
      email: '  MOI@VienChiBao.com ',
      fullName: '  Nhân viên mới  ',
      password: 'Matkhau@123',
      role: UserRole.staff,
      phoneNumber: ' 0987654321 ',
    });

    const data = prisma.user.create.mock.calls[0][0].data;
    expect(data.email).toBe('moi@vienchibao.com');
    expect(data.name).toBe('Nhân viên mới');
    expect(data.phone).toBe('0987654321');
    expect(data.roles).toEqual({ set: ['staff'] });
    expect(data.tenantId).toBe('tenant-uuid');
    // Mật khẩu không được lưu thô.
    expect(data.passwordHash).not.toBe('Matkhau@123');
    expect(await bcrypt.compare('Matkhau@123', data.passwordHash)).toBe(true);

    expect(out).toMatchObject({ id: 9, role: 'staff', roleLabel: 'Staff' });
  });

  it('không có tenant nào → tenantId null, vẫn tạo được', async () => {
    const prisma = makePrisma();
    prisma.tenant.findFirst.mockResolvedValue(null);
    const svc = new RbacService(prisma as never, makeActivity() as never);
    await svc.createUser({
      email: 'moi2@vienchibao.com',
      fullName: 'Không tenant',
      password: 'Matkhau@123',
      role: UserRole.user,
    });
    expect(prisma.user.create.mock.calls[0][0].data.tenantId).toBeNull();
  });
});

describe('RbacService', () => {
  it('listRoles trả 4 vai trò + userCount', async () => {
    const svc = new RbacService(makePrisma() as never, makeActivity() as never);
    const roles = await svc.listRoles();
    expect(roles.map((r) => r.code)).toEqual([
      'admin',
      'manager',
      'staff',
      'user',
    ]);
    expect(Object.fromEntries(roles.map((r) => [r.code, r.userCount]))).toEqual(
      {
        admin: 2,
        manager: 0,
        staff: 1,
        user: 1,
      },
    );
  });

  it('listUsers gộp role + lastActiveAt', async () => {
    const map = new Map([['1', '2026-09-10T03:00:00.000Z']]);
    const svc = new RbacService(
      makePrisma() as never,
      makeActivity(map) as never,
    );
    const {
      items: rows,
      total,
      page,
      pageSize,
      totalPages,
    } = await svc.listUsers();
    expect(rows[0]).toMatchObject({
      id: 1,
      fullName: 'Bùi Duy Cường',
      role: 'admin',
      roleLabel: 'Admin',
      permissionSummary: 'Toàn bộ hệ thống, chỉnh sửa tiêu chí & API',
      lastActiveAt: '2026-09-10T03:00:00.000Z',
    });
    expect(rows[1]).toMatchObject({ id: 2, role: 'staff', lastActiveAt: null });
    expect(rows[2]).toMatchObject({ id: 3, role: 'user' });
    // roles: ['staff', 'admin'] → ưu tiên admin (multi-role tie-break).
    expect(rows[3]).toMatchObject({ id: 4, role: 'admin', roleLabel: 'Admin' });
    // Mặc định: trang 1, 20 dòng/trang.
    expect({ total, page, pageSize, totalPages }).toEqual({
      total: 4,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
  });

  it('listUsers: search lọc theo tên hoặc email, không phân biệt hoa thường', async () => {
    const prisma = makePrisma();
    const svc = new RbacService(prisma as never, makeActivity() as never);
    await svc.listUsers({ search: '  Huong  ' });
    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { name: { contains: 'Huong', mode: 'insensitive' } },
      { email: { contains: 'Huong', mode: 'insensitive' } },
    ]);
    // count phải dùng đúng where đó để tổng số khớp với danh sách.
    expect(prisma.user.count).toHaveBeenCalledWith({ where });
  });

  it('listUsers: lọc theo vai trò dùng roles has', async () => {
    const prisma = makePrisma();
    const svc = new RbacService(prisma as never, makeActivity() as never);
    await svc.listUsers({ role: UserRole.manager });
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
      roles: { has: 'manager' },
    });
  });

  it('listUsers: phân trang tính skip/take đúng', async () => {
    const prisma = makePrisma();
    prisma.user.count.mockResolvedValue(45);
    const svc = new RbacService(prisma as never, makeActivity() as never);
    const out = await svc.listUsers({ page: 3, pageSize: 10 });
    expect(prisma.user.findMany.mock.calls[0][0]).toMatchObject({
      skip: 20,
      take: 10,
    });
    expect(out).toMatchObject({
      total: 45,
      page: 3,
      pageSize: 10,
      totalPages: 5,
    });
  });

  it('listUsers: không có filter thì where rỗng', async () => {
    const prisma = makePrisma();
    const svc = new RbacService(prisma as never, makeActivity() as never);
    await svc.listUsers({ search: '   ' });
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({});
  });

  it('listUsers: sortDir áp cho orderBy tên (mặc định sortBy=name)', async () => {
    const prisma = makePrisma();
    const svc = new RbacService(prisma as never, makeActivity() as never);
    await svc.listUsers({ sortDir: 'desc' });
    expect(prisma.user.findMany.mock.calls[0][0].orderBy).toEqual([
      { name: 'desc' },
      { id: 'asc' },
    ]);
  });

  describe('listUsers: sortBy=lastActive — sort ở tầng ứng dụng, không orderBy DB', () => {
    // id1 mới nhất, id4 giữa, id2 cũ nhất, id3 chưa hoạt động bao giờ (null).
    const map = new Map([
      ['1', '2026-09-10T05:00:00.000Z'],
      ['2', '2026-09-10T01:00:00.000Z'],
      ['4', '2026-09-10T03:00:00.000Z'],
    ]);

    it('desc (mặc định bấm lần đầu ở FE): mới → cũ, null (chưa hoạt động) xuống cuối', async () => {
      const svc = new RbacService(
        makePrisma() as never,
        makeActivity(map) as never,
      );
      const { items, total } = await svc.listUsers({
        sortBy: 'lastActive',
        sortDir: 'desc',
        pageSize: 20,
      });
      expect(items.map((u) => u.id)).toEqual([1, 4, 2, 3]);
      expect(total).toBe(4);
    });

    it('asc (bấm lần nữa, đảo ngược): null (chưa hoạt động) lên đầu, rồi cũ → mới', async () => {
      const svc = new RbacService(
        makePrisma() as never,
        makeActivity(map) as never,
      );
      const { items } = await svc.listUsers({
        sortBy: 'lastActive',
        pageSize: 20,
      });
      expect(items.map((u) => u.id)).toEqual([3, 2, 4, 1]);
    });

    it('phân trang cắt đúng sau khi sort, total tính trên toàn bộ danh sách', async () => {
      const svc = new RbacService(
        makePrisma() as never,
        makeActivity(map) as never,
      );
      const { items, total, totalPages } = await svc.listUsers({
        sortBy: 'lastActive',
        page: 2,
        pageSize: 2,
      });
      // Thứ tự asc mặc định đầy đủ: [3, 2, 4, 1] → trang 2 (size 2) là [4, 1].
      expect(items.map((u) => u.id)).toEqual([4, 1]);
      expect(total).toBe(4);
      expect(totalPages).toBe(2);
    });

    it('không gọi prisma.user.count — tự tính total từ danh sách đã lấy hết', async () => {
      const prisma = makePrisma();
      const svc = new RbacService(prisma as never, makeActivity(map) as never);
      await svc.listUsers({ sortBy: 'lastActive' });
      expect(prisma.user.count).not.toHaveBeenCalled();
      // Lấy hết (không skip/take) để sort đúng trước khi cắt trang.
      expect(prisma.user.findMany.mock.calls[0][0].skip).toBeUndefined();
      expect(prisma.user.findMany.mock.calls[0][0].take).toBeUndefined();
    });
  });

  it('assignRole map role → update users.roles bằng { set }', async () => {
    const prisma = makePrisma();
    const svc = new RbacService(prisma as never, makeActivity() as never);
    const out = await svc.assignRole('2', UserRole.manager);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 2n },
      data: { roles: { set: ['manager'] } },
    });
    expect(out).toEqual({ id: 2, role: 'manager' });
  });

  it("assignRole map role staff → update users.roles bằng { set: ['staff'] }", async () => {
    const prisma = makePrisma();
    const svc = new RbacService(prisma as never, makeActivity() as never);
    const out = await svc.assignRole('2', UserRole.staff);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 2n },
      data: { roles: { set: ['staff'] } },
    });
    expect(out).toEqual({ id: 2, role: 'staff' });
  });

  it('assignRole: id không phải số → BadRequestException', async () => {
    const svc = new RbacService(makePrisma() as never, makeActivity() as never);
    await expect(
      svc.assignRole('abc', UserRole.manager),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('assignRole: user không tồn tại → NotFoundException', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const svc = new RbacService(prisma as never, makeActivity() as never);
    await expect(
      svc.assignRole('999', UserRole.manager),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('RbacController (wiring)', () => {
  it('route trả về đúng envelope { success, data }', async () => {
    const rbac = {
      listRoles: jest.fn().mockResolvedValue([{ code: 'admin' }]),
      listUsers: jest.fn().mockResolvedValue({
        items: [{ id: 1 }],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      }),
      createUser: jest.fn().mockResolvedValue({ id: 9, role: 'staff' }),
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
    expect(await ctrl.roles()).toEqual({
      success: true,
      data: [{ code: 'admin' }],
    });
    expect(await ctrl.users({})).toEqual({
      success: true,
      data: {
        items: [{ id: 1 }],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      },
    });
    expect(
      await ctrl.createUser({
        email: 'moi@vienchibao.com',
        fullName: 'Nhân viên mới',
        password: 'Matkhau@123',
        role: 'staff',
      } as never),
    ).toEqual({
      success: true,
      message: 'Tạo người dùng thành công',
      data: { id: 9, role: 'staff' },
    });
    expect(await ctrl.assignRole('1', { role: 'manager' } as never)).toEqual({
      success: true,
      message: 'Cập nhật vai trò thành công',
      data: { id: 1, role: 'manager' },
    });
  });

  it('áp dụng JwtAuthGuard + RolesGuard ở cấp class (@UseGuards)', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA_KEY, RbacController) as
      | unknown[]
      | undefined;
    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(RolesGuard);
  });

  it('yêu cầu vai trò admin (@Roles(UserRole.admin))', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, RbacController) as
      | UserRole[]
      | undefined;
    expect(roles).toEqual([UserRole.admin]);
  });

  it('RbacModule đăng ký RbacActivityInterceptor làm APP_INTERCEPTOR toàn cục', () => {
    const providers = Reflect.getMetadata(MODULE_PROVIDERS_KEY, RbacModule) as
      | unknown[]
      | undefined;
    expect(providers).toContain(RbacService);
    expect(providers).toContain(RbacActivityService);
    expect(providers).toContainEqual({
      provide: APP_INTERCEPTOR,
      useClass: RbacActivityInterceptor,
    });
  });
});
