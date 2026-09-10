import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

import { RbacService } from './rbac.service';
import { AssignRoleDto } from './dto/assign-role.dto';

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
  async users() {
    return { success: true, data: await this.rbac.listUsers() };
  }

  @Put('users/:id/role')
  async assignRole(@Param('id') id: string, @Body() dto: AssignRoleDto) {
    const data = await this.rbac.assignRole(id, dto.role);
    return { success: true, message: 'Cập nhật vai trò thành công', data };
  }
}
