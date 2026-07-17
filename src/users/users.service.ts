import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User } from '@prisma/client';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { parseUserId, prismaRolesFromCqaRole, toPublicUser } from './user-role.util';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

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
    return this.prisma.user.findUnique({
      where: { id: parseUserId(id) },
    });
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
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        ...rest,
        ...(fullName !== undefined ? { name: fullName } : {}),
        ...(password !== undefined ? { passwordHash: password } : {}),
        ...(phoneNumber !== undefined ? { phone: phoneNumber } : {}),
        ...(role !== undefined ? { roles: prismaRolesFromCqaRole(role) } : {}),
      },
    });
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
  }
}
