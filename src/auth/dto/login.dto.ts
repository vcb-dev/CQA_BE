import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({
    example: 'user1',
    description: 'Email hoặc tài khoản (vd. user1 → user1@cqa.vn)',
  })
  @IsString()
  @IsNotEmpty({ message: 'Tài khoản không được để trống' })
  email: string;

  @ApiProperty({
    example: 'Password123',
    description: 'Mật khẩu đăng nhập',
  })
  @IsString()
  @IsNotEmpty({ message: 'Mật khẩu không được để trống' })
  @MinLength(6, { message: 'Mật khẩu phải có ít nhất 6 ký tự' })
  password: string;
}
