import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AppService } from './app.service';

@ApiTags('app')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({ summary: 'Endpoint gốc — kiểm tra service đang chạy' })
  getHello(): string {
    return this.appService.getHello();
  }

  /** Healthcheck cho Railway / load balancer — không auth. */
  @Get('health')
  @ApiOperation({
    summary: 'Healthcheck cho load balancer / Railway (không cần auth)',
  })
  health() {
    return {
      ok: true,
      service: 'cqa-be',
      mode: process.env.CSKH_RUN_MODE || 'api',
      ts: new Date().toISOString(),
    };
  }
}
