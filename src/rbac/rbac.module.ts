import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RbacController } from './rbac.controller';
import { RbacService } from './rbac.service';
import { RbacActivityService } from './rbac-activity.service';
import { RbacActivityInterceptor } from './rbac-activity.interceptor';

@Module({
  controllers: [RbacController],
  providers: [
    RbacService,
    RbacActivityService,
    { provide: APP_INTERCEPTOR, useClass: RbacActivityInterceptor },
  ],
})
export class RbacModule {}
