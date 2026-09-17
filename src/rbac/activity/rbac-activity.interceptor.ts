import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { RbacActivityService } from './rbac-activity.service';

/**
 * Global interceptor: mỗi request đã xác thực (`req.user` do JwtAuthGuard set)
 * → cập nhật mốc "Hoạt động cuối". Không chặn, không đổi response.
 */
@Injectable()
export class RbacActivityInterceptor implements NestInterceptor {
  constructor(private readonly activity: RbacActivityService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ user?: { id?: unknown } }>();
    const userId = req?.user?.id;
    if (userId != null) {
      void this.activity.markActive(userId as bigint | number | string);
    }
    return next.handle();
  }
}
