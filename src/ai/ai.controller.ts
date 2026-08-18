import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AiService } from './ai.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';
import { AssistantChatDto } from './dto/assistant-chat.dto';

@ApiTags('ai')
@ApiBearerAuth('JWT-auth')
@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('audit-chat')
  async auditChat(@Body() body: any) {
    return this.aiService.auditChat(body);
  }

  @Post('assistant/chat')
  async assistantChat(@CurrentUser() user: User, @Body() body: AssistantChatDto) {
    return this.aiService.assistantChat(user, body);
  }
}
