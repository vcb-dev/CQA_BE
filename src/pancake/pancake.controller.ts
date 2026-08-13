import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';
import { PancakeService } from './pancake.service';

@ApiTags('pancake')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('pancake')
export class PancakeController {
  constructor(private readonly pancake: PancakeService) {}

  @Post('connect')
  connect(@CurrentUser() user: User, @Body() body: { accessToken?: string }) {
    return this.pancake.connect(body.accessToken ?? '', user.tenantId || undefined);
  }

  @Get('status')
  status(@CurrentUser() user: User) {
    return this.pancake.status(user.tenantId || undefined);
  }

  @Delete('disconnect')
  disconnect(@CurrentUser() user: User) {
    return this.pancake.disconnect(user.tenantId || undefined);
  }

  @Get('pages')
  listPages(@CurrentUser() user: User) {
    return this.pancake.listPages(user.tenantId || undefined);
  }

  /** Lead từ DB CRM (sau sync / webhook). from=live = gọi Pancake API. */
  @Get('pages/:pageId/leads')
  listLeads(
    @CurrentUser() user: User,
    @Param('pageId') pageId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('from') from?: string,
  ) {
    const lim = limit ? Math.min(500, Math.max(1, parseInt(limit, 10) || 50)) : 50;
    if (from === 'live') {
      return this.pancake.listLeads(pageId, {
        cursor,
        limit: Math.min(lim, 100),
        tenantId: user.tenantId || undefined,
      });
    }
    const offset = cursor ? parseInt(cursor, 10) || 0 : 0;
    return this.pancake.listStoredLeads(pageId, {
      limit: lim,
      offset,
      tenantId: user.tenantId || undefined,
    });
  }

  /** Đồng bộ page_customers → pancake_leads (+ quét chat tự gán nhãn). */
  @Post('pages/:pageId/sync')
  syncPage(@CurrentUser() user: User, @Param('pageId') pageId: string) {
    return this.pancake.syncPageCustomers(pageId, {
      tenantId: user.tenantId || undefined,
    });
  }

  /** Quét hội thoại → tự gán follow / Đã chốt theo SĐT·địa chỉ + tín hiệu CK/đơn trong chat. */
  @Post('pages/:pageId/auto-label')
  autoLabel(
    @CurrentUser() user: User,
    @Param('pageId') pageId: string,
    @Body() body?: { maxScan?: number },
  ) {
    return this.pancake.scanAndAutoLabelPageLeads(pageId, {
      tenantId: user.tenantId || undefined,
      maxScan: body?.maxScan,
    });
  }

  /** Follow / nhãn / gắn SĐT·địa chỉ / nâng stage. */
  @Patch('leads/:leadId')
  updateLead(
    @Param('leadId') leadId: string,
    @Body()
    body: {
      labels?: string[];
      follow?: boolean;
      stage?: 'conversation' | 'customer';
      phone?: string;
      address?: string;
      notes?: string;
      orderRef?: string;
    },
  ) {
    return this.pancake.updateLeadCrm(leadId, body);
  }

  /** Đánh dấu đã đặt hàng → customer + SĐT/địa chỉ. */
  @Post('leads/:leadId/mark-customer')
  markCustomer(
    @Param('leadId') leadId: string,
    @Body()
    body: {
      phone?: string;
      address?: string;
      orderRef?: string;
      notes?: string;
    },
  ) {
    return this.pancake.updateLeadCrm(leadId, {
      ...body,
      stage: 'customer',
    });
  }

  @Get('pages/:pageId/conversations')
  listConversations(
    @CurrentUser() user: User,
    @Param('pageId') pageId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const lim = limit ? Math.min(100, Math.max(1, parseInt(limit, 10) || 30)) : 30;
    return this.pancake.listConversations(pageId, {
      cursor,
      limit: lim,
      tenantId: user.tenantId || undefined,
    });
  }

  @Get('pages/:pageId/conversations/:conversationId/messages')
  listMessages(
    @CurrentUser() user: User,
    @Param('pageId') pageId: string,
    @Param('conversationId') conversationId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const lim = limit ? Math.min(100, Math.max(1, parseInt(limit, 10) || 50)) : 50;
    return this.pancake.listMessages(pageId, conversationId, {
      cursor,
      limit: lim,
      tenantId: user.tenantId || undefined,
    });
  }

  @Get('pages/:pageId/conversations/:conversationId/lead-preview')
  leadPreview(
    @CurrentUser() user: User,
    @Param('pageId') pageId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.pancake.leadPreview(pageId, conversationId, {
      tenantId: user.tenantId || undefined,
    });
  }
}

/** Webhook Pancake — không JWT. */
@ApiTags('pancake-webhook')
@Controller('pancake')
export class PancakeWebhookController {
  constructor(private readonly pancake: PancakeService) {}

  @Post('webhook')
  async webhook(
    @Body() body: unknown,
    @Headers('x-pancake-secret') headerSecret?: string,
    @Query('secret') querySecret?: string,
  ) {
    const expected = process.env.PANCAKE_WEBHOOK_SECRET;
    if (expected) {
      const got = headerSecret || querySecret || '';
      if (got !== expected) {
        throw new UnauthorizedException('Invalid pancake webhook secret');
      }
    }
    return this.pancake.handleWebhook(body);
  }

  @Get('webhook')
  webhookPing() {
    return {
      ok: true,
      service: 'cqa-pancake-webhook',
      hint: 'POST JSON events from Pancake to this URL',
    };
  }
}
