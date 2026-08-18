import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import {
  COOKIE_ACCESS,
  COOKIE_CSRF,
  COOKIE_REFRESH,
  LEGACY_COOKIE_ACCESS,
  LEGACY_COOKIE_REFRESH,
} from './cookie.constants';

@Injectable()
export class CookieAuthService {
  constructor(private readonly config: ConfigService) {}

  private apiAuthPath(): string {
    const prefix = (this.config.get<string>('API_PREFIX') || 'api/v1').replace(
      /^\/+|\/+$/g,
      '',
    );
    return `/${prefix}/auth`;
  }

  private cookieFlags(): { secure: boolean; sameSite: 'lax' | 'none' } {
    const frontendUrl = this.config.get<string>('FRONTEND_URL') || '';
    const isHttps = frontendUrl.startsWith('https://');
    const secure =
      this.config.get<string>('COOKIE_SECURE', isHttps ? 'true' : 'false') ===
      'true';
    return {
      secure,
      sameSite: isHttps ? 'none' : 'lax',
    };
  }

  private baseOptions(): CookieOptions {
    const { secure, sameSite } = this.cookieFlags();
    return {
      httpOnly: true,
      secure,
      sameSite,
      path: '/',
    };
  }

  setAuthCookies(
    res: Response,
    tokens: { accessToken: string; refreshToken: string },
  ): string {
    const accessMaxAge = this.parseDurationMs(
      this.config.get<string>('jwt.expiresIn') ||
        this.config.get<string>('JWT_EXPIRES_IN') ||
        '7d',
    );
    const refreshMaxAge = this.parseDurationMs(
      this.config.get<string>('jwt.refreshExpiresIn') ||
        this.config.get<string>('JWT_REFRESH_EXPIRES_IN') ||
        '30d',
    );
    const csrf = randomBytes(32).toString('hex');
    const { secure, sameSite } = this.cookieFlags();

    res.cookie(COOKIE_ACCESS, tokens.accessToken, {
      ...this.baseOptions(),
      maxAge: accessMaxAge,
    });

    res.cookie(COOKIE_REFRESH, tokens.refreshToken, {
      ...this.baseOptions(),
      maxAge: refreshMaxAge,
      path: this.apiAuthPath(),
    });

    res.cookie(COOKIE_CSRF, csrf, {
      httpOnly: false,
      secure,
      sameSite,
      path: '/',
      maxAge: refreshMaxAge,
    });

    this.clearLegacyCookies(res);
    return csrf;
  }

  ensureCsrfCookie(req: Request, res: Response): string {
    const existing = req.cookies?.[COOKIE_CSRF];
    if (typeof existing === 'string' && existing.length > 0) {
      return existing;
    }
    const csrf = randomBytes(32).toString('hex');
    const refreshMaxAge = this.parseDurationMs(
      this.config.get<string>('jwt.refreshExpiresIn') ||
        this.config.get<string>('JWT_REFRESH_EXPIRES_IN') ||
        '30d',
    );
    const { secure, sameSite } = this.cookieFlags();
    res.cookie(COOKIE_CSRF, csrf, {
      httpOnly: false,
      secure,
      sameSite,
      path: '/',
      maxAge: refreshMaxAge,
    });
    return csrf;
  }

  clearAuthCookies(res: Response) {
    const { secure, sameSite } = this.cookieFlags();
    res.clearCookie(COOKIE_ACCESS, { path: '/', sameSite, secure });
    res.clearCookie(COOKIE_REFRESH, {
      path: this.apiAuthPath(),
      sameSite,
      secure,
    });
    res.clearCookie(COOKIE_CSRF, { path: '/', sameSite, secure });
    this.clearLegacyCookies(res);
  }

  private clearLegacyCookies(res: Response) {
    const { secure, sameSite } = this.cookieFlags();
    res.clearCookie(LEGACY_COOKIE_ACCESS, { path: '/', sameSite, secure });
    res.clearCookie(LEGACY_COOKIE_REFRESH, { path: '/', sameSite, secure });
  }

  private parseDurationMs(value: string): number {
    const v = value.trim().toLowerCase();
    const m = /^(\d+)([smhd])$/.exec(v);
    if (!m) return 15 * 60 * 1000;
    const n = Number(m[1]);
    const unit = m[2];
    const mult =
      unit === 's'
        ? 1000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : 86_400_000;
    return n * mult;
  }
}
