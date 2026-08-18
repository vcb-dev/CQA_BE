import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { COOKIE_CSRF, CSRF_HEADER } from '../cookie.constants';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      return true;
    }

    const path = req.path || req.url || '';
    if (
      path.endsWith('/auth/login') ||
      path.endsWith('/auth/register') ||
      path.endsWith('/auth/csrf') ||
      path.endsWith('/webhook')
    ) {
      return true;
    }

    const authHeader = headerValue(req, 'authorization');
    if (authHeader?.toLowerCase().startsWith('bearer ')) {
      return true;
    }

    const cookieToken = req.cookies?.[COOKIE_CSRF] as string | undefined;
    if (!cookieToken) {
      return true;
    }

    const headerToken = headerValue(req, CSRF_HEADER);
    if (!headerToken || cookieToken !== headerToken) {
      throw new ForbiddenException('CSRF token không hợp lệ');
    }

    return true;
  }
}
