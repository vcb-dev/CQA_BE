import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Request,
  Res,
  Query,
  UnauthorizedException,
  HttpException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@ApiTags('auth')
@Controller('auth')
@ApiBearerAuth('JWT-auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  private setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || '';
    const isHttps = frontendUrl.startsWith('https://');
    const secure = isHttps;
    const sameSite = isHttps ? 'none' : 'lax';

    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: secure,
      sameSite: sameSite,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: secure,
      sameSite: sameSite,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }

  private extractHttpErrorMessage(err: unknown): string {
    if (err instanceof HttpException) {
      const body = err.getResponse();
      if (typeof body === 'string') return body;
      if (body && typeof body === 'object' && 'message' in body) {
        const msg = (body as { message?: string | string[] }).message;
        if (Array.isArray(msg)) return msg.join(', ');
        if (typeof msg === 'string') return msg;
      }
    }
    if (err instanceof Error && err.message && err.message !== 'Unauthorized') {
      return err.message;
    }
    return 'Đăng nhập Google thất bại';
  }

  private clearAuthCookies(res: Response) {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || '';
    const isHttps = frontendUrl.startsWith('https://');
    const secure = isHttps;
    const sameSite = isHttps ? 'none' : 'lax';
    
    res.clearCookie('accessToken', {
      httpOnly: true,
      secure: secure,
      sameSite: sameSite,
    });
    
    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: secure,
      sameSite: sameSite,
    });
  }

  // POST /auth/register
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() registerDto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(registerDto);
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return {
      success: true,
      message: 'Đăng ký thành công',
      data: {
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      },
    };
  }

  // POST /auth/login — tài khoản + mật khẩu
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(loginDto);
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return {
      success: true,
      message: 'Đăng nhập thành công',
      data: {
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      },
    };
  }

  // POST /auth/refresh
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refreshToken(
    @Request() req: any,
    @Res({ passthrough: true }) res: Response,
    @Body() refreshTokenDto?: RefreshTokenDto,
  ) {
    const token = req.cookies?.refreshToken || refreshTokenDto?.refreshToken;
    if (!token) {
      throw new UnauthorizedException('Không tìm thấy Refresh Token');
    }

    const result = await this.authService.refreshToken(token);
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return {
      success: true,
      message: 'Làm mới token thành công',
      data: {
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      },
    };
  }

  // GET /auth/me
  @Get('me')
  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  async getProfile(@CurrentUser() user: User) {
    return {
      success: true,
      message: 'Lấy thông tin thành công',
      data: await this.authService.getProfile(user.id),
    };
  }

  // POST /auth/logout
  @Post('logout')
  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(@Res({ passthrough: true }) res: Response) {
    this.clearAuthCookies(res);
    return {
      success: true,
      message: 'Đăng xuất thành công',
    };
  }

  // GET /auth/google
  @Get('google')
  async googleAuth(@Res() res: Response) {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const callbackUrl = this.configService.get<string>('GOOGLE_CALLBACK_URL');
    if (!clientId || !callbackUrl) {
      return res.status(400).json({
        success: false,
        message: 'Google login is not configured on the server',
      });
    }

    const googleUrl =
      `https://accounts.google.com/o/oauth2/v2/auth?` +
      `response_type=code` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(callbackUrl)}` +
      `&scope=openid%20profile%20email` +
      `&prompt=select_account`;

    return res.redirect(googleUrl);
  }

  // GET /auth/google/callback
  @Get('google/callback')
  async googleAuthCallback(
    @Query('code') code: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const rawFrontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173';
    const frontendUrl = rawFrontendUrl.replace(/\/+$/, '');

    if (error) {
      return res.redirect(
        `${frontendUrl}/login?error=${encodeURIComponent('Google login rejected: ' + error)}`,
      );
    }

    if (!code) {
      return res.redirect(
        `${frontendUrl}/login?error=${encodeURIComponent('No authorization code provided')}`,
      );
    }

    try {
      const tokens = await this.authService.loginWithGoogle(code);
      this.setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
      return res.redirect(
        `${frontendUrl}/login#token=${tokens.accessToken}&refreshToken=${tokens.refreshToken}`,
      );
    } catch (err: unknown) {
      const errMsg = this.extractHttpErrorMessage(err);
      return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent(errMsg)}`);
    }
  }
}
