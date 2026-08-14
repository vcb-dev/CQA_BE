import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';
import { CskhModule } from '../cskh/cskh.module';
import { PancakeClient } from './pancake.client';
import { PancakeService } from './pancake.service';
import { PancakeController, PancakeWebhookController } from './pancake.controller';

@Module({
  imports: [PrismaModule, AiModule, forwardRef(() => CskhModule)],
  controllers: [PancakeController, PancakeWebhookController],
  providers: [PancakeClient, PancakeService],
  exports: [PancakeService],
})
export class PancakeModule {}
