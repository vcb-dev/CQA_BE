import { Module } from '@nestjs/common';
import { CskhController } from './cskh.controller';
import { CskhService } from './cskh.service';
import { CskhInboxService } from './cskh-inbox.service';
import { CskhInboxRealtimeService } from './cskh-inbox-realtime.service';
import { FacebookGraphService } from './facebook-graph.service';
import { SapoProductService } from './sapo-product.service';
import { SapoOAuthService } from './sapo-oauth.service';
import { CskhCronService } from './cskh-cron.service';
import { RedisQueueService } from './redis-queue.service';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AiModule, AuthModule, UsersModule],
  controllers: [CskhController],
  providers: [
    CskhService,
    CskhInboxService,
    CskhInboxRealtimeService,
    FacebookGraphService,
    SapoProductService,
    SapoOAuthService,
    CskhCronService,
    RedisQueueService,
  ],
  exports: [CskhService, CskhInboxService, RedisQueueService],
})
export class CskhModule {}
