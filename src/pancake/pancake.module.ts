import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';
import { PancakeClient } from './pancake.client';
import { PancakeService } from './pancake.service';
import { PancakeController, PancakeWebhookController } from './pancake.controller';

@Module({
  imports: [PrismaModule, AiModule],
  controllers: [PancakeController, PancakeWebhookController],
  providers: [PancakeClient, PancakeService],
  exports: [PancakeService],
})
export class PancakeModule {}
