import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import {
  primaryRoleFromPrisma,
  prismaRolesFromInput,
} from '../users/user-role.util';
import { RBAC_CATALOG, RBAC_CATALOG_BY_CODE } from './dto/rbac.catalog';
import { CreateUserDto } from './dto/create-user.dto';
import {
  ListUsersQueryDto,
  RBAC_USERS_DEFAULT_PAGE_SIZE,
} from './dto/list-users-query.dto';

const PASSWORD_SALT_ROUNDS = 12;

@Injectable()
export class RbacService {
  constructor(private readonly prisma: PrismaService) {}

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

  /**
   * Danh sách người dùng cho bảng "Phân quyền", có lọc + sắp xếp + phân trang.
   * Lọc theo vai trò làm ở tầng DB bằng `roles has`, khớp với cách
   * `primaryRoleFromPrisma` chọn vai trò chính nên số liệu không lệch.
   */
  async listUsers(query: ListUsersQueryDto = {}) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? RBAC_USERS_DEFAULT_PAGE_SIZE;
    const sortDir = query.sortDir ?? 'asc';

    const where: Prisma.UserWhereInput = {};

    const search = query.search?.trim();
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (query.role) {
      where.roles = { has: query.role };
    }

    // "Hoạt động cuối" giờ là cột DB thật (users.last_active_at) nên orderBy
    // thẳng được ở Prisma, không cần lấy hết rồi sort tay như hồi còn Redis.
    // null (chưa hoạt động bao giờ) luôn coi là mốc cũ nhất: asc → lên đầu,
    // desc → xuống cuối — ngược với NULLS mặc định của Postgres nên khai rõ.
    const orderBy: Prisma.UserOrderByWithRelationInput[] =
      query.sortBy === 'lastActive'
        ? [
            {
              lastActiveAt: {
                sort: sortDir,
                nulls: sortDir === 'desc' ? 'last' : 'first',
              },
            },
            { name: 'asc' },
            { id: 'asc' },
          ]
        : [{ name: sortDir }, { id: 'asc' }];

    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          email: true,
          roles: true,
          avatarUrl: true,
          lastActiveAt: true,
        },
      }),
    ]);

    const items = rows.map((u) => this.toRbacUserItem(u));

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  private toRbacUserItem(u: {
    id: bigint;
    name: string | null;
    email: string;
    roles: UserRole[];
    avatarUrl: string | null;
    lastActiveAt: Date | null;
  }) {
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
      lastActiveAt: u.lastActiveAt ? u.lastActiveAt.toISOString() : null,
    };
  }

  /** Tạo người dùng mới kèm vai trò. Mật khẩu là mật khẩu tạm, hash trước khi lưu. */
  async createUser(dto: CreateUserDto) {
    const email = dto.email.trim().toLowerCase();

    const existing = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('Email này đã được sử dụng');
    }

    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_SALT_ROUNDS);

    // Gắn user vào tenant đang có để hiển thị đúng phạm vi dữ liệu.
    const tenant = await this.prisma.tenant.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    const created = await this.prisma.user.create({
      data: {
        email,
        name: dto.fullName.trim(),
        passwordHash,
        phone: dto.phoneNumber?.trim() || null,
        roles: { set: prismaRolesFromInput(dto.role) },
        tenantId: tenant?.id ?? null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        roles: true,
        avatarUrl: true,
        lastActiveAt: true,
      },
    });

    return this.toRbacUserItem(created);
  }

  /** Đổi vai trò của 1 user. Ghi thẳng cột users.roles. */
  async assignRole(userId: string, role: UserRole) {
    if (!/^\d+$/.test(userId)) {
      throw new BadRequestException('id người dùng không hợp lệ');
    }
    const id = BigInt(userId);
    const existing = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, roles: true },
    });
    if (!existing) {
      throw new NotFoundException(`Không tìm thấy người dùng với id ${userId}`);
    }

    // Chặn bỏ vai trò Admin của Admin cuối cùng — tránh tự/lẫn nhau khóa hết quyền quản trị.
    const isCurrentlyAdmin =
      primaryRoleFromPrisma(existing.roles) === UserRole.admin;
    if (isCurrentlyAdmin && role !== UserRole.admin) {
      const otherAdmins = await this.prisma.user.count({
        where: { id: { not: id }, roles: { has: UserRole.admin } },
      });
      if (otherAdmins === 0) {
        throw new ConflictException(
          'Không thể bỏ vai trò Admin của Admin cuối cùng trong hệ thống',
        );
      }
    }

    await this.prisma.user.update({
      where: { id },
      data: { roles: { set: prismaRolesFromInput(role) } },
    });
    return { id: Number(userId), role };
  }
}
