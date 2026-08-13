import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TenantsModule } from './tenants/tenants.module';
import jwtConfig from './config/jwt.config';
import { PrismaModule } from './prisma/prisma.module';
import { CskhModule } from './cskh/cskh.module';
import { AiModule } from './ai/ai.module';
import { PancakeModule } from './pancake/pancake.module';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    // ─── Schedule ───────────────────────────────────────────────────────────────
    ScheduleModule.forRoot(),

    // ─── Rate Limiting (Throttler) ──────────────────────────────────────────────
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // 1 minute
        limit: 120, // 120 requests per IP per minute
      },
    ]),

    // ─── Config ─────────────────────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [jwtConfig],
    }),

    // ─── Feature Modules ─────────────────────────────────────────────────────────
    PrismaModule,
    TenantsModule,
    AuthModule,
    UsersModule,
    CskhModule,
    AiModule,
    PancakeModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
