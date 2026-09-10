import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CQA_RBAC_ROLES, type CqaRbacRole } from '../rbac-role.util';

export class AssignRoleDto {
  @ApiProperty({ enum: CQA_RBAC_ROLES, example: 'manager' })
  @IsIn(CQA_RBAC_ROLES, { message: 'Vai trò không hợp lệ' })
  role: CqaRbacRole;
}
