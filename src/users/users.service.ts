import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User } from '@prisma/client';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Create ──────────────────────────────────────────────────────────────────
  async create(createUserDto: CreateUserDto): Promise<User> {
    return this.prisma.user.create({
      data: createUserDto,
    });
  }

  // ─── Find All ─────────────────────────────────────────────────────────────────
  async findAll(): Promise<Omit<User, 'password'>[]> {
    return this.prisma.user.findMany({
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        isActive: true,
        avatarUrl: true,
        phoneNumber: true,
        tenantId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  // ─── Find by ID ───────────────────────────────────────────────────────────────
  async findById(id: number): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  // ─── Find by Email ────────────────────────────────────────────────────────────
  async findByEmail(email: string): Promise<User | null> {
    const normalized = email.trim().toLowerCase();
    return this.prisma.user.findFirst({
      where: { email: { equals: normalized, mode: 'insensitive' } },
    });
  }

  // ─── Update ──────────────────────────────────────────────────────────────────
  async update(id: number, updateUserDto: UpdateUserDto): Promise<User> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException(`Không tìm thấy người dùng với id ${id}`);
    }
    return this.prisma.user.update({
      where: { id },
      data: updateUserDto,
    });
  }

  // ─── Remove ──────────────────────────────────────────────────────────────────
  async remove(id: number): Promise<void> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException(`Không tìm thấy người dùng với id ${id}`);
    }
    await this.prisma.user.delete({
      where: { id },
    });
  }
}
