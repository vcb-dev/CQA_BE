import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

import { RbacService } from './rbac.service';
import { AssignRoleDto } from './dto/assign-role.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';

@ApiTags('rbac')
@ApiBearerAuth('JWT-auth')
@Controller('rbac')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin)
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  @Get('roles')
  async roles() {
    return { success: true, data: await this.rbac.listRoles() };
  }

  @Get('users')
  async users(@Query() query: ListUsersQueryDto) {
    return { success: true, data: await this.rbac.listUsers(query) };
  }

  @Post('users')
  @HttpCode(HttpStatus.CREATED)
  async createUser(@Body() dto: CreateUserDto) {
    const data = await this.rbac.createUser(dto);
    return { success: true, message: 'Tạo người dùng thành công', data };
  }

  @Put('users/:id/role')
  async assignRole(@Param('id') id: string, @Body() dto: AssignRoleDto) {
    const data = await this.rbac.assignRole(id, dto.role);
    return { success: true, message: 'Cập nhật vai trò thành công', data };
  }
}
