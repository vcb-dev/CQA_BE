import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { User } from '@prisma/client';
import axios from 'axios';
import { cqaRoleFromPrisma, toPublicUser } from '../users/user-role.util';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  private resolveLoginIdentifier(input: string): string {
    const trimmed = input.trim().toLowerCase();
    if (trimmed.includes('@')) return trimmed;
    return `${trimmed}@cqa.vn`;
  }

  async validateUser(identifier: string, password: string): Promise<User | null> {
    const email = this.resolveLoginIdentifier(identifier);
    const user = await this.usersService.findByEmail(email);
    if (!user?.passwordHash) return null;

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) return null;

    return user;
  }

  async login(loginDto: { email: string; password: string }) {
    const user = await this.validateUser(loginDto.email, loginDto.password);
    if (!user) {
      throw new UnauthorizedException('Tài khoản hoặc mật khẩu không đúng');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('Tài khoản đã bị khóa');
    }
    const tokens = await this.generateTokens(user);
    return {
      user: toPublicUser(user),
      ...tokens,
    };
  }

  async register(registerDto: RegisterDto) {
    const existing = await this.usersService.findByEmail(registerDto.email);
    if (existing) {
      throw new BadRequestException('Email đã được sử dụng');
    }

    const hashedPassword = await bcrypt.hash(registerDto.password, 12);
    const user = await this.usersService.create({
      ...registerDto,
      password: hashedPassword,
    });

    const tokens = await this.generateTokens(user);
    return {
      user: toPublicUser(user),
      ...tokens,
    };
  }

  async refreshToken(refreshToken: string) {
    try {
      const payload = this.jwtService.verify<JwtPayload>(refreshToken, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
      });

      const user = await this.usersService.findById(payload.sub);
      if (!user || !user.isActive) {
        throw new UnauthorizedException('Token không hợp lệ');
      }

      const tokens = await this.generateTokens(user);
      return {
        user: toPublicUser(user),
        ...tokens,
      };
    } catch {
      throw new UnauthorizedException('Refresh token không hợp lệ hoặc đã hết hạn');
    }
  }

  async getProfile(userId: string | number | bigint) {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Không tìm thấy người dùng');
    }
    return toPublicUser(user);
  }

  private async generateTokens(user: User) {
    const payload: JwtPayload = {
      sub: user.id.toString(),
      email: user.email,
      role: cqaRoleFromPrisma(user.roles),
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('jwt.secret') as string,
        expiresIn: (this.configService.get<string>('jwt.expiresIn') || '7d') as any,
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('jwt.refreshSecret') as string,
        expiresIn: (this.configService.get<string>('jwt.refreshExpiresIn') || '30d') as any,
      }),
    ]);

    return { accessToken, refreshToken };
  }

  async loginWithGoogle(code: string) {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET');
    const callbackUrl = this.configService.get<string>('GOOGLE_CALLBACK_URL');

    if (!clientId || !clientSecret || !callbackUrl) {
      throw new BadRequestException('Google credentials are not configured on the server');
    }

    let googleAccessToken: string;
    try {
      const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: callbackUrl,
        grant_type: 'authorization_code',
      });
      googleAccessToken = tokenResponse.data.access_token;
    } catch (err: any) {
      throw new BadRequestException(
        'Failed to exchange code with Google: ' +
          (err.response?.data?.error_description || err.message),
      );
    }

    let profile: { email: string; name: string; picture?: string };
    try {
      const profileResponse = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${googleAccessToken}` },
      });
      profile = profileResponse.data;
    } catch (err: any) {
      throw new BadRequestException('Failed to retrieve profile from Google: ' + err.message);
    }

    if (!profile.email) {
      throw new BadRequestException('Google profile does not contain email');
    }

    const email = profile.email.trim().toLowerCase();
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      throw new UnauthorizedException(
        'Email bạn không được phép truy cập vào hệ thống.',
      );
    }

    let activeUser = user;
    if (!activeUser.avatarUrl && profile.picture) {
      activeUser = await this.usersService.update(activeUser.id, { avatarUrl: profile.picture });
    }

    if (!activeUser.isActive) {
      throw new UnauthorizedException('Tài khoản đã bị khóa');
    }

    const tokens = await this.generateTokens(activeUser);
    return {
      user: toPublicUser(activeUser),
      ...tokens,
    };
  }
}
