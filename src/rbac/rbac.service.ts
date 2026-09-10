import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { primaryRoleFromPrisma, prismaRolesFromInput } from '../users/user-role.util';
import { RbacActivityService } from './rbac-activity.service';
import { RBAC_CATALOG, RBAC_CATALOG_BY_CODE } from './rbac.catalog';

@Injectable()
export class RbacService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: RbacActivityService,
  ) {}

  /** Catalog 4 vai trò + số user đang giữ mỗi vai trò. */
  async listRoles() {
    const rows = await this.prisma.user.findMany({ select: { roles: true } });
    const counts = new Map<UserRole, number>();
    for (const r of rows) {
      const code = primaryRoleFromPrisma(r.roles);
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return RBAC_CATALOG.map((def) => ({
      ...def,
      userCount: counts.get(def.code) ?? 0,
    }));
  }

  /** Danh sách người dùng cho bảng "Phân quyền". */
  async listUsers() {
    const rows = await this.prisma.user.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        email: true,
        roles: true,
        avatarUrl: true,
      },
    });
    const activeMap = await this.activity.getActiveMap(rows.map((u) => u.id));
    return rows.map((u) => {
      const role = primaryRoleFromPrisma(u.roles);
      const def = RBAC_CATALOG_BY_CODE[role];
      return {
        id: Number(u.id),
        fullName: u.name,
        email: u.email,
        avatarUrl: u.avatarUrl,
        role,
        roleLabel: def.label,
        permissionSummary: def.description,
        permissions: def.permissions,
        lastActiveAt: activeMap.get(String(u.id)) ?? null,
      };
    });
  }

  /** Đổi vai trò của 1 user. Ghi thẳng cột users.roles. */
  async assignRole(userId: string, role: UserRole) {
    if (!/^\d+$/.test(userId)) {
      throw new BadRequestException('id người dùng không hợp lệ');
    }
    const id = BigInt(userId);
    const existing = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException(`Không tìm thấy người dùng với id ${userId}`);
    }
    await this.prisma.user.update({
      where: { id },
      data: { roles: { set: prismaRolesFromInput(role) } },
    });
    return { id: Number(userId), role };
  }
}
