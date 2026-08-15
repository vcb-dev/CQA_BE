import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User } from '@prisma/client';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { parseUserId, prismaRolesFromCqaRole, toPublicUser } from './user-role.util';

@Injectable()
export class UsersService {
  /** JWT gọi findById mọi request — cache ngắn để auth không tranh Prisma pool với COUNT nặng. */
  private readonly byIdCache = new Map<string, { at: number; user: User | null }>();
  private readonly byIdTtlMs = Number(process.env.CSKH_JWT_USER_CACHE_MS || 60_000);

  constructor(private readonly prisma: PrismaService) {}

  private cacheKey(id: bigint): string {
    return String(id);
  }

  private readCached(id: bigint): User | null | undefined {
    const hit = this.byIdCache.get(this.cacheKey(id));
    if (!hit) return undefined;
    if (Date.now() - hit.at >= this.byIdTtlMs) {
      this.byIdCache.delete(this.cacheKey(id));
      return undefined;
    }
    return hit.user;
  }

  private writeCached(id: bigint, user: User | null) {
    this.byIdCache.set(this.cacheKey(id), { at: Date.now(), user });
  }

  private invalidateCached(id: bigint) {
    this.byIdCache.delete(this.cacheKey(id));
  }

  async create(createUserDto: CreateUserDto): Promise<User> {
    const { fullName, password, phoneNumber, role, ...rest } = createUserDto;
    return this.prisma.user.create({
      data: {
        ...rest,
        name: fullName,
        passwordHash: password,
        phone: phoneNumber,
        roles: role ? prismaRolesFromCqaRole(role) : ['sales'],
      },
    });
  }

  async findAll() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return users.map(toPublicUser);
  }

  async findById(id: string | number | bigint): Promise<User | null> {
    const userId = parseUserId(id);
    const cached = this.readCached(userId);
    if (cached !== undefined) return cached;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    this.writeCached(userId, user);
    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    const normalized = email.trim().toLowerCase();
    return this.prisma.user.findFirst({
      where: { email: { equals: normalized, mode: 'insensitive' } },
    });
  }

  async update(id: string | number | bigint, updateUserDto: UpdateUserDto): Promise<User> {
    const userId = parseUserId(id);
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundException(`Không tìm thấy người dùng với id ${id}`);
    }

    const { fullName, password, phoneNumber, role, ...rest } = updateUserDto;
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...rest,
        ...(fullName !== undefined ? { name: fullName } : {}),
        ...(password !== undefined ? { passwordHash: password } : {}),
        ...(phoneNumber !== undefined ? { phone: phoneNumber } : {}),
        ...(role !== undefined ? { roles: prismaRolesFromCqaRole(role) } : {}),
      },
    });
    this.writeCached(userId, updated);
    return updated;
  }

  async remove(id: string | number | bigint): Promise<void> {
    const userId = parseUserId(id);
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundException(`Không tìm thấy người dùng với id ${id}`);
    }
    await this.prisma.user.delete({
      where: { id: userId },
    });
    this.invalidateCached(userId);
  }
}
