import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PancakeClient } from './pancake.client';
import { PancakeService } from './pancake.service';
import { PancakeController, PancakeWebhookController } from './pancake.controller';

@Module({
  imports: [PrismaModule],
  controllers: [PancakeController, PancakeWebhookController],
  providers: [PancakeClient, PancakeService],
  exports: [PancakeService],
})
export class PancakeModule {}
