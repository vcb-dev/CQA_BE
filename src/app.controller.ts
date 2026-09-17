import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /** Healthcheck cho Railway / load balancer — không auth. */
  @Get('health')
  health() {
    return {
      ok: true,
      service: 'cqa-be',
      mode: process.env.CSKH_RUN_MODE || 'api',
      ts: new Date().toISOString(),
    };
  }
}
