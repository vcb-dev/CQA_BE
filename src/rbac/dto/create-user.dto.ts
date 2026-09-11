import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { RBAC_ROLE_CODES } from '../rbac.catalog';

export class CreateUserDto {
  @ApiProperty({ example: 'nhanvien@vienchibao.com' })
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email: string;

  @ApiProperty({ example: 'Nguyễn Thu Hương' })
  @IsString()
  @MinLength(2, { message: 'Họ tên phải có ít nhất 2 ký tự' })
  @MaxLength(100, { message: 'Họ tên tối đa 100 ký tự' })
  fullName: string;

  @ApiProperty({
    example: 'Matkhau@123',
    description: 'Mật khẩu tạm, người dùng đổi sau khi đăng nhập',
  })
  @IsString()
  @MinLength(6, { message: 'Mật khẩu phải có ít nhất 6 ký tự' })
  password: string;

  @ApiProperty({ enum: RBAC_ROLE_CODES, example: 'staff' })
  @IsIn(RBAC_ROLE_CODES, { message: 'Vai trò không hợp lệ' })
  role: UserRole;

  @ApiPropertyOptional({ example: '0987654321' })
  @IsOptional()
  @IsString()
  @MaxLength(20, { message: 'Số điện thoại tối đa 20 ký tự' })
  phoneNumber?: string;
}
