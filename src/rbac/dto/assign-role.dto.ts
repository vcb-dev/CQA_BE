import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { RBAC_ROLE_CODES } from '../rbac.catalog';

export class AssignRoleDto {
  @ApiProperty({ enum: RBAC_ROLE_CODES, example: 'manager' })
  @IsIn(RBAC_ROLE_CODES, { message: 'Vai trò không hợp lệ' })
  role: UserRole;
}
