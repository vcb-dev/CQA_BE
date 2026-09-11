import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { RBAC_ROLE_CODES } from '../rbac.catalog';

export const RBAC_USERS_DEFAULT_PAGE_SIZE = 20;
export const RBAC_USERS_MAX_PAGE_SIZE = 100;

export type RbacUsersSortBy = 'name' | 'lastActive';
export type RbacUsersSortDir = 'asc' | 'desc';

export class ListUsersQueryDto {
  @ApiPropertyOptional({
    description: 'Tìm theo tên hoặc email',
    example: 'huong',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    enum: RBAC_ROLE_CODES,
    description: 'Lọc theo vai trò',
  })
  @IsOptional()
  @IsIn(RBAC_ROLE_CODES, { message: 'Vai trò không hợp lệ' })
  role?: UserRole;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Trang phải là số nguyên' })
  @Min(1, { message: 'Trang phải từ 1 trở lên' })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: RBAC_USERS_MAX_PAGE_SIZE,
    default: RBAC_USERS_DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Số dòng mỗi trang phải là số nguyên' })
  @Min(1, { message: 'Số dòng mỗi trang phải từ 1 trở lên' })
  @Max(RBAC_USERS_MAX_PAGE_SIZE, {
    message: `Số dòng mỗi trang tối đa ${RBAC_USERS_MAX_PAGE_SIZE}`,
  })
  pageSize?: number;

  @ApiPropertyOptional({
    enum: ['name', 'lastActive'],
    default: 'name',
    description:
      'Sắp theo tên (mặc định, orderBy ở DB) hoặc "Hoạt động cuối" (mốc không nằm trong DB, sort ở tầng ứng dụng).',
  })
  @IsOptional()
  @IsIn(['name', 'lastActive'], { message: 'Trường sắp xếp không hợp lệ' })
  sortBy?: RbacUsersSortBy;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'Chiều sắp xếp không hợp lệ' })
  sortDir?: RbacUsersSortDir;
}
