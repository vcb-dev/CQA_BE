import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
  Res,
  Query,
  UnauthorizedException,
  HttpException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { CookieAuthService } from './cookie-auth.service';
import { COOKIE_REFRESH, LEGACY_COOKIE_REFRESH } from './cookie.constants';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@ApiTags('auth')
@Controller('auth')
@ApiBearerAuth('JWT-auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly cookies: CookieAuthService,
    private readonly configService: ConfigService,
  ) {}

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

  private readRefreshCookie(req: Request): string | undefined {
    const token =
      (req.cookies?.[COOKIE_REFRESH] as string | undefined) ||
      (req.cookies?.[LEGACY_COOKIE_REFRESH] as string | undefined);
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  }

  /** CSRF double-submit — FE đọc cookie hoặc gọi endpoint này khi khác origin. */
  @Get('csrf')
  csrf(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return {
      success: true,
      data: { csrfToken: this.cookies.ensureCsrfCookie(req, res) },
    };
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() registerDto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(registerDto);
    const csrfToken = this.cookies.setAuthCookies(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
    return {
      success: true,
      message: 'Đăng ký thành công',
      data: { user: result.user, csrfToken },
    };
  }

  /** Email + mật khẩu → HttpOnly cookies (không trả token trong JSON) */
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(loginDto);
    const csrfToken = this.cookies.setAuthCookies(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
    return {
      success: true,
      message: 'Đăng nhập thành công',
      data: { user: result.user, csrfToken },
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refreshToken(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = this.readRefreshCookie(req);
    if (!token) {
      throw new UnauthorizedException('Không tìm thấy Refresh Token');
    }

    const result = await this.authService.refreshToken(token);
    const csrfToken = this.cookies.setAuthCookies(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
    return {
      success: true,
      message: 'Làm mới token thành công',
      data: { user: result.user, csrfToken },
    };
  }

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

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Res({ passthrough: true }) res: Response) {
    this.cookies.clearAuthCookies(res);
    return {
      success: true,
      message: 'Đăng xuất thành công',
    };
  }

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

  @Get('google/callback')
  async googleAuthCallback(
    @Query('code') code: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const rawFrontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173';
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
      this.cookies.setAuthCookies(res, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
      return res.redirect(`${frontendUrl}/login?oauth=ok`);
    } catch (err: unknown) {
      const errMsg = this.extractHttpErrorMessage(err);
      return res.redirect(
        `${frontendUrl}/login?error=${encodeURIComponent(errMsg)}`,
      );
    }
  }
}
