import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { isPrismaBusyError, isPrismaClientFailure } from '../prisma-busy.util';
import { toUserFacingError } from '../user-facing-error.util';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Lỗi hệ thống, vui lòng thử lại sau';
    let errors: unknown = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const res = exceptionResponse as Record<string, unknown>;
        message = (res.message as string) || message;
        if (Array.isArray(res.message)) {
          errors = res.message;
          message = 'Dữ liệu đầu vào không hợp lệ';
        }
      }
    } else if (isPrismaBusyError(exception) || isPrismaClientFailure(exception)) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      message = 'Hệ thống đang bận tải dữ liệu. Vui lòng thử lại sau vài giây.';
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} - ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (
      status === HttpStatus.SERVICE_UNAVAILABLE ||
      isPrismaBusyError(exception) ||
      isPrismaClientFailure(exception)
    ) {
      this.logger.warn(
        `${request.method} ${request.url} - ${status} ${String((exception as Error)?.message || exception).slice(0, 180)}`,
      );
    }

    const bodyMessage = status >= 500 || isPrismaBusyError(exception)
      ? toUserFacingError(typeof message === 'string' ? message : String(message))
      : message;

    response.status(status).json({
      success: false,
      statusCode: status,
      message: bodyMessage,
      errors,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
