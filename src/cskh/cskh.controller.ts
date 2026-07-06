import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Res,
  Req,
  Headers,
  UseGuards,
  BadRequestException,
  UnauthorizedException,
  Sse,
  MessageEvent,
  Header,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import type { RawBodyRequest } from '@nestjs/common';
import { merge, interval, map, filter, Observable } from 'rxjs';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CskhService } from './cskh.service';
import { CskhInsightService } from './cskh-insight.service';
import { CskhInboxService } from './inbox/cskh-inbox.service';
import { CskhInboxLabelsService } from './inbox/cskh-inbox-labels.service';
import {
  CskhInboxRealtimeService,
  type InboxRealtimePayload,
} from './inbox/cskh-inbox-realtime.service';
import { RedisQueueService } from './redis/redis-queue.service';
import { getCskhRunMode } from './cskh-run-mode';
import { verifyFacebookWebhookSignature } from './facebook/facebook-oauth.util';
import { parseMediaProxyUrlFromRequest } from './facebook/facebook-message.util';
import { SapoOAuthService } from './sapo/sapo-oauth.service';
import { SapoProductService } from './sapo/sapo-product.service';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { ConfigService } from '@nestjs/config';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@ApiTags('cskh')
@ApiBearerAuth('JWT-auth')
@Controller('cskh')
export class CskhController {
  constructor(
    private readonly cskh: CskhService,
    private readonly insights: CskhInsightService,
    private readonly inbox: CskhInboxService,
    private readonly inboxLabels: CskhInboxLabelsService,
    private readonly inboxRealtime: CskhInboxRealtimeService,
    private readonly redisQueue: RedisQueueService,
    private readonly sapoOAuth: SapoOAuthService,
    private readonly sapoProducts: SapoProductService,
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {}

  /** OAuth — không cần JWT (redirect browser). */
  @Get('oauth/start')
  async oauthStart(
    @Query('returnUrl') returnUrl: string,
    @Query('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const tenantId = await this.resolveOAuthTenantId(token, req);
    const url = this.cskh.getOAuthStartUrl(returnUrl, tenantId);
    return res.redirect(url);
  }

  private async resolveOAuthTenantId(
    token: string | undefined,
    req: Request,
  ): Promise<string | undefined> {
    const candidates = [token, req.cookies?.accessToken as string | undefined].filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    const secret = this.configService.get<string>('jwt.secret');
    for (const authToken of candidates) {
      try {
        const payload = this.jwtService.verify(authToken, { secret });
        if (payload?.sub) {
          const user = await this.usersService.findById(payload.sub);
          if (user?.isActive && user.tenantId) return user.tenantId;
        }
      } catch {
        /* thử nguồn token tiếp theo */
      }
    }
    return undefined;
  }

  @Get('oauth/callback')
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Query('error_description') errorDescription: string,
    @Res() res: Response,
  ) {
    if (error) {
      const msg = encodeURIComponent(errorDescription || error);
      return res.redirect(`${this.cskh.defaultOAuthReturnUrl()}&oauth_error=${msg}`);
    }
    try {
      const result = await this.cskh.handleOAuthCallback(code, state);
      const base = result.returnUrl || this.cskh.defaultOAuthReturnUrl();
      const sep = base.includes('?') ? '&' : '?';
      const fbParam = result.syncing ? 'syncing' : String(result.pageCount);
      return res.redirect(`${base}${sep}fb_connected=${fbParam}`);
    } catch (e) {
      const msg = encodeURIComponent(e instanceof Error ? e.message : 'OAuth failed');
      return res.redirect(`${this.cskh.defaultOAuthReturnUrl()}&oauth_error=${msg}`);
    }
  }

  @Get('pages')
  @UseGuards(JwtAuthGuard)
  listPages(
    @CurrentUser() user: User,
    @Query('month') month?: string,
    @Query('date') date?: string,
    @Query('lite') lite?: string,
  ) {
    const monthTrimmed = month?.trim();
    const dateTrimmed = date?.trim();
    if (monthTrimmed && !/^\d{4}-\d{2}$/.test(monthTrimmed)) {
      throw new BadRequestException('Tháng không hợp lệ (YYYY-MM)');
    }
    if (dateTrimmed && !/^\d{4}-\d{2}-\d{2}$/.test(dateTrimmed)) {
      throw new BadRequestException('Ngày không hợp lệ (YYYY-MM-DD)');
    }
    if (monthTrimmed && dateTrimmed) {
      throw new BadRequestException('Chỉ dùng một trong hai: month hoặc date');
    }
    return this.cskh.listPages(user.tenantId || undefined, {
      month: monthTrimmed || undefined,
      date: dateTrimmed || undefined,
      lite: lite === '1' || lite === 'true',
    });
  }

  /** Kiểm tra nhanh BE đã deploy bản có thống kê tin theo tháng chưa. */
  @Get('features')
  @UseGuards(JwtAuthGuard)
  getFeatures() {
    return {
      inboundMonthStats: true,
      inboundDayStats: true,
      pageAdSpendDaily: true,
      buildTag: 'page-ad-spend-v1',
    };
  }

  @Post('pages/sync-ad-spend')
  @UseGuards(JwtAuthGuard)
  syncPagesAdSpend(
    @CurrentUser() user: User,
    @Query('date') date?: string,
  ) {
    const dateTrimmed = date?.trim();
    const statDate =
      dateTrimmed && /^\d{4}-\d{2}-\d{2}$/.test(dateTrimmed)
        ? dateTrimmed
        : this.cskh.vietnamCalendarDate(0);
    return this.cskh.syncAllPagesAdSpend([statDate], user.tenantId || undefined);
  }

  @Put('pages/manual')
  @UseGuards(JwtAuthGuard)
  saveManualPage(
    @CurrentUser() user: User,
    @Body()
    body: {
      pageId?: string;
      pageName?: string;
      pageAccessToken?: string;
    },
  ) {
    return this.cskh.savePageConfig(
      {
        pageId: body.pageId?.trim() ?? '',
        pageName: body.pageName,
        pageAccessToken: body.pageAccessToken ?? '',
      },
      user.tenantId || undefined,
    );
  }

  @Patch('pages/bulk-enabled')
  @UseGuards(JwtAuthGuard)
  setPagesEnabledBulk(@CurrentUser() user: User, @Body() body: { enabled?: boolean; pageIds?: string[] }) {
    return this.cskh.setPagesEnabledBulk(Boolean(body.enabled), body.pageIds, user.tenantId || undefined);
  }

  @Patch('pages/:pageId/enabled')
  @UseGuards(JwtAuthGuard)
  setPageEnabled(
    @CurrentUser() user: User,
    @Param('pageId') pageId: string,
    @Body() body: { enabled?: boolean },
  ) {
    return this.cskh.setPageEnabled(pageId, Boolean(body.enabled), user.tenantId || undefined);
  }

  @Delete('pages/:pageId')
  @UseGuards(JwtAuthGuard)
  deletePage(@CurrentUser() user: User, @Param('pageId') pageId: string) {
    return this.cskh.deletePage(pageId, user.tenantId || undefined);
  }

  @Post('oauth/refresh')
  @UseGuards(JwtAuthGuard)
  refreshOAuth(@CurrentUser() user: User) {
    return this.cskh.refreshPagesFromOAuth(user.tenantId || undefined);
  }

  /** Sapo Partner OAuth — redirect browser (cài Client lên shop). */
  @Get('sapo/oauth/start')
  sapoOAuthStart(@Res() res: Response) {
    const url = this.sapoOAuth.getOAuthStartUrl();
    return res.redirect(url);
  }

  @Get('sapo/oauth/callback')
  async sapoOAuthCallback(
    @Query('code') code: string,
    @Query('error') error: string,
    @Query('error_description') errorDescription: string,
    @Res() res: Response,
  ) {
    if (error) {
      const msg = errorDescription || error;
      res.type('html').send(`<h1>Sapo OAuth lỗi</h1><p>${msg}</p>`);
      return;
    }
    try {
      const result = await this.sapoOAuth.exchangeCode(code);
      res.type('html').send(
        `<h1>Sapo OAuth thành công</h1>
         <p>Shop đã cấp quyền cho Partner App.</p>
         <p>SP mẫu: ${result.sampleProductTitle ?? '(chưa đọc được — kiểm tra scope read_products)'}</p>
         <p><strong>Thêm vào env Cloud Run / .env BE:</strong></p>
         <pre>SAPO_ACCESS_TOKEN=${result.accessToken}</pre>
         <p>Sau đó restart BE. Không commit token vào git.</p>`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'OAuth failed';
      res.type('html').send(`<h1>Sapo OAuth lỗi</h1><pre>${msg}</pre>`);
    }
  }

  @Get('sapo/status')
  @UseGuards(JwtAuthGuard)
  async sapoStatus() {
    const oauthReady = this.sapoOAuth.isOAuthConfigured();
    const apiReady = this.sapoProducts.isConfigured();
    let variantCount = 0;
    if (apiReady) {
      const catalog = await this.sapoProducts.getCatalog();
      variantCount = catalog.length;
    }
    return {
      oauthReady,
      apiReady,
      redirectUri: oauthReady ? this.sapoOAuth.getRedirectUri() : null,
      authorizeUrl: oauthReady ? this.sapoOAuth.getOAuthStartUrl() : null,
      variantCount,
    };
  }

  @Get('monitor/latest')
  @UseGuards(JwtAuthGuard)
  latestMonitor(@CurrentUser() user: User) {
    return this.cskh.getLatestMonitor(user.tenantId || undefined);
  }

  @Post('monitor/run')
  @UseGuards(JwtAuthGuard)
  async runMonitor(@CurrentUser() user: User, @Body() body: { maxConversations?: number }) {
    const running = await this.cskh.findRunningJob('monitor', user.tenantId || undefined);
    if (running) {
      return { jobId: running.id, status: 'running', alreadyRunning: true };
    }
    const job = await this.cskh.createJob('monitor', user.tenantId || undefined);
    void this.cskh.runMonitorJob(job.id, body.maxConversations);
    return { jobId: job.id, status: 'running', alreadyRunning: false };
  }

  @Post('audit/run')
  @UseGuards(JwtAuthGuard)
  async runAudit(
    @CurrentUser() user: User,
    @Body()
    body: {
      auditDate?: string;
      auditDateFrom?: string;
      auditDateTo?: string;
      maxConversations?: number;
      force?: boolean;
      pageId?: string;
      /** Quét tất cả kênh — mỗi kênh tối đa maxConversations cuộc. */
      scanAllChannels?: boolean;
    },
  ) {
    const auditDateFrom = (body.auditDateFrom || body.auditDate || '').trim();
    const auditDateTo = (body.auditDateTo || body.auditDateFrom || body.auditDate || '').trim();
    if (!auditDateFrom || !/^\d{4}-\d{2}-\d{2}$/.test(auditDateFrom)) {
      throw new BadRequestException('Bắt buộc chọn ngày bắt đầu (YYYY-MM-DD)');
    }
    if (!auditDateTo || !/^\d{4}-\d{2}-\d{2}$/.test(auditDateTo)) {
      throw new BadRequestException('Bắt buộc chọn ngày kết thúc (YYYY-MM-DD)');
    }
    if (auditDateFrom > auditDateTo) {
      throw new BadRequestException('Ngày bắt đầu phải trước hoặc bằng ngày kết thúc');
    }
    const pageId = body.pageId?.trim() || undefined;
    const scanAllChannels = Boolean(body.scanAllChannels) || !pageId;
    if (!scanAllChannels && !pageId) {
      throw new BadRequestException('Thiếu pageId hoặc bật scanAllChannels');
    }
    const maxConversations =
      body.maxConversations != null && body.maxConversations > 0
        ? Math.min(5000, Math.floor(body.maxConversations))
        : undefined;
    if (body.force) {
      await this.cskh.cancelRunningJobs('audit', undefined, user.tenantId || undefined);
    } else {
      await this.cskh.releaseStaleJobs('audit', 5 * 60 * 1000, user.tenantId || undefined);
    }
    const running = await this.cskh.findRunningJob('audit', user.tenantId || undefined);
    if (running) {
      return { jobId: running.id, status: 'running', alreadyRunning: true };
    }
    const job = await this.cskh.createJob('audit', user.tenantId || undefined);
    const auditOptions = {
      auditDateFrom,
      auditDateTo,
      maxConversations,
      force: Boolean(body.force),
      pageId: scanAllChannels ? undefined : pageId,
    };
    const queued = await this.redisQueue.enqueueAuditJob({ jobId: job.id, options: auditOptions });
    if (!queued) {
      if (getCskhRunMode() === 'all') {
        void this.cskh.runAuditJob(job.id, auditOptions);
      } else {
        throw new BadRequestException(
          'Không thể xếp hàng chấm CSKH (Redis). Kiểm tra REDIS_URL và worker service.',
        );
      }
    }
    const workerOnline = await this.redisQueue.isAuditWorkerAlive();
    return {
      jobId: job.id,
      status: 'running',
      alreadyRunning: false,
      workerOnline,
    };
  }

  @Post('audit/pause')
  @UseGuards(JwtAuthGuard)
  pauseAudit(@CurrentUser() user: User) {
    return this.cskh.requestAuditPause(user.tenantId || undefined);
  }

  @Post('audit/cancel')
  @UseGuards(JwtAuthGuard)
  async cancelAudit(@CurrentUser() user: User) {
    const n = await this.cskh.cancelRunningJobs('audit', undefined, user.tenantId || undefined);
    return { cancelled: n };
  }

  @Get('audit/token-stats')
  @UseGuards(JwtAuthGuard)
  getAuditTokenStats() {
    return this.cskh.getAuditTokenStats();
  }

  @Get('audit/progress/:jobId')
  @UseGuards(JwtAuthGuard)
  getAuditProgress(@CurrentUser() user: User, @Param('jobId') jobId: string) {
    return this.cskh.getAuditProgress(jobId, user.tenantId || undefined);
  }

  @Get('jobs/running/:type')
  @UseGuards(JwtAuthGuard)
  getRunningJob(@CurrentUser() user: User, @Param('type') type: string) {
    if (type !== 'monitor' && type !== 'audit') {
      return null;
    }
    return this.cskh.getRunningJob(type, user.tenantId || undefined);
  }

  @Get('jobs/:id')
  @UseGuards(JwtAuthGuard)
  getJob(@CurrentUser() user: User, @Param('id') id: string) {
    return this.cskh.getJob(id, user.tenantId || undefined);
  }

  @Get('audits')
  @UseGuards(JwtAuthGuard)
  listAudits(
    @CurrentUser() user: User,
    @Query('pageId') pageId?: string,
    @Query('jobRunId') jobRunId?: string,
    @Query('auditDate') auditDate?: string,
    @Query('auditDateFrom') auditDateFrom?: string,
    @Query('auditDateTo') auditDateTo?: string,
    @Query('limit') limit?: string,
  ) {
    return this.cskh.listAudits(
      {
        pageId: pageId?.trim(),
        jobRunId: jobRunId?.trim(),
        auditDate: auditDate?.trim(),
        auditDateFrom: auditDateFrom?.trim(),
        auditDateTo: auditDateTo?.trim(),
        limit: limit ? Number(limit) : undefined,
      },
      user.tenantId || undefined,
    );
  }

  @Get('insights')
  @UseGuards(JwtAuthGuard)
  getInsights(
    @CurrentUser() user: User,
    @Query('auditDateFrom') auditDateFrom?: string,
    @Query('auditDateTo') auditDateTo?: string,
    @Query('pageId') pageId?: string,
  ) {
    const from = auditDateFrom?.trim();
    if (!from) throw new BadRequestException('Bắt buộc auditDateFrom (YYYY-MM-DD)');
    return this.insights.getDashboard({
      auditDateFrom: from,
      auditDateTo: auditDateTo?.trim(),
      pageId: pageId?.trim(),
      tenantId: user.tenantId || undefined,
    });
  }

  @Get('audits/day-stats')
  @UseGuards(JwtAuthGuard)
  getAuditDayStats(
    @CurrentUser() user: User,
    @Query('auditDate') auditDate?: string,
    @Query('auditDateFrom') auditDateFrom?: string,
    @Query('auditDateTo') auditDateTo?: string,
    @Query('pageId') pageId?: string,
  ) {
    const from = (auditDateFrom || auditDate)?.trim();
    if (!from) throw new BadRequestException('Bắt buộc auditDateFrom hoặc auditDate (YYYY-MM-DD)');
    return this.cskh.getAuditDayStats(from, auditDateTo?.trim(), pageId?.trim(), user.tenantId || undefined);
  }

  @Get('audits/comparison')
  @UseGuards(JwtAuthGuard)
  getAuditComparison(
    @CurrentUser() user: User,
    @Query('auditDate') auditDate?: string,
    @Query('auditId') auditId?: string,
  ) {
    const day = auditDate?.trim();
    const id = auditId?.trim();
    if (!day) throw new BadRequestException('Bắt buộc auditDate (YYYY-MM-DD)');
    if (!id) throw new BadRequestException('Bắt buộc auditId');
    return this.cskh.getAuditComparisonStats(day, id, user.tenantId || undefined);
  }

  @Get('audits/score-history')
  @UseGuards(JwtAuthGuard)
  getAuditScoreHistory(@CurrentUser() user: User, @Query('auditId') auditId?: string) {
    const id = auditId?.trim();
    if (!id) throw new BadRequestException('Bắt buộc auditId');
    return this.cskh.getAuditScoreHistory(id, user.tenantId || undefined);
  }

  @Get('ai/balance')
  @UseGuards(JwtAuthGuard)
  getAiBalance() {
    return this.cskh.getDeepSeekBalance();
  }

  /** Meta Webhook verify — không JWT. */
  @Get('webhook')
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    console.log(`[Webhook GET] Received verification request: mode=${mode}, token=${token}, challenge=${challenge}`);
    try {
      const result = this.inbox.verifyWebhookToken(mode, token, challenge);
      console.log(`[Webhook GET] Verification successful. Returning challenge: ${result}`);
      return result;
    } catch (e) {
      console.error(`[Webhook GET] Verification failed: ${(e as Error).message}`);
      throw e;
    }
  }

  /** Meta Webhook events — không JWT. */
  @Post('webhook')
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string,
  ) {
    const raw = req.rawBody;
    console.log(`[Webhook POST] Received event from Meta. Signature header: ${signature}, Raw body length: ${raw ? raw.length : 0}`);
    
    if (!raw || !verifyFacebookWebhookSignature(raw, signature)) {
      console.warn(`[Webhook POST] Rejecting request due to signature verification failure.`);
      throw new UnauthorizedException('Invalid webhook signature');
    }
    
    try {
      console.log(`[Webhook POST] Processing payload: ${JSON.stringify(req.body).slice(0, 1000)}`);
      const result = await this.inbox.handleWebhookPayload(req.body);
      console.log(`[Webhook POST] Payload processed successfully: ${JSON.stringify(result)}`);
      return result;
    } catch (e) {
      console.error(`[Webhook POST] Error processing webhook payload: ${(e as Error).message}`, e);
      throw e;
    }
  }

  @Get('inbox/conversation-stats')
  @UseGuards(JwtAuthGuard)
  inboxConversationStats(@CurrentUser() user: User, @Query('pageId') pageId?: string) {
    return this.inbox.getConversationStats(pageId?.trim(), user.tenantId || undefined);
  }

  @Get('inbox/conversations')
  @UseGuards(JwtAuthGuard)
  listInboxConversations(
    @CurrentUser() user: User,
    @Query('pageId') pageId?: string,
    @Query('fromAdOnly') fromAdOnly?: string,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('organicOnly') organicOnly?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('search') search?: string,
    @Query('sinceDays') sinceDays?: string,
    @Query('labelId') labelId?: string,
    @Query('unlabeledOnly') unlabeledOnly?: string,
    @Query('includeLabels') includeLabels?: string,
    @Query('legacy') legacy?: string,
  ) {
    const parsedLimit = limit ? Number(limit) : undefined;
    const parsedSinceDays = sinceDays ? Number(sinceDays) : undefined;
    const opts = {
      fromAdOnly: fromAdOnly === '1' || fromAdOnly === 'true',
      unreadOnly: unreadOnly === '1' || unreadOnly === 'true',
      organicOnly: organicOnly === '1' || organicOnly === 'true',
      limit: Number.isFinite(parsedLimit) && parsedLimit! > 0 ? parsedLimit : undefined,
      cursor: cursor?.trim() || undefined,
      search: search?.trim() || undefined,
      sinceDays:
        Number.isFinite(parsedSinceDays) && parsedSinceDays! > 0 ? parsedSinceDays : undefined,
      labelId: labelId?.trim() || undefined,
      unlabeledOnly: unlabeledOnly === '1' || unlabeledOnly === 'true',
      includeLabels: includeLabels === '1' || includeLabels === 'true',
    };
    if (legacy === '1' || legacy === 'true') {
      return this.inbox.listConversationsLegacy(pageId?.trim(), user.tenantId || undefined, opts);
    }
    return this.inbox.listConversations(pageId?.trim(), user.tenantId || undefined, opts);
  }

  /** Gắn lại tag Ads từ tin nhắn đã lưu (Việt/Anh/Thái) — chạy ngay, không chờ cooldown. */
  @Post('inbox/backfill-ad-referrals')
  @UseGuards(JwtAuthGuard)
  backfillAdReferrals(@CurrentUser() user: User) {
    return this.inbox.backfillAdReferralsFromDb(user.tenantId || undefined);
  }

  @Get('inbox/labels')
  @UseGuards(JwtAuthGuard)
  listInboxLabels(@CurrentUser() user: User) {
    return this.inboxLabels.listLabels(user.tenantId || undefined);
  }

  @Get('inbox/conversations/:id/view-history')
  @UseGuards(JwtAuthGuard)
  getInboxViewHistory(@CurrentUser() user: User, @Param('id') id: string) {
    return this.inboxLabels.getViewHistory(id.trim(), user.tenantId || undefined);
  }

  @Post('inbox/conversations/:id/labels/:labelId/toggle')
  @UseGuards(JwtAuthGuard)
  toggleInboxConversationLabel(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Param('labelId') labelId: string,
  ) {
    return this.inboxLabels.toggleConversationLabel(
      id.trim(),
      labelId.trim(),
      user.id,
      user.tenantId || undefined,
    );
  }

  /** SSE — push realtime khi webhook/send có tin mới (FE không cần bấm đồng bộ). */
  @Sse('inbox/stream')
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache, no-transform')
  @Header('Connection', 'keep-alive')
  @Header('X-Accel-Buffering', 'no')
  @UseGuards(JwtAuthGuard)
  inboxStream(@CurrentUser() user: User): Observable<MessageEvent> {
    this.inbox.touchUserActivity();
    const heartbeat = interval(25_000).pipe(
      map(() => ({ data: { type: 'ping' } }) as MessageEvent),
    );
    const tenantId = user.tenantId || undefined;
    const filteredStream = this.inboxRealtime.stream().pipe(
      filter((event) => {
        const payload = event.data as InboxRealtimePayload | undefined;
        if (!payload?.tenantId || !tenantId) return true;
        return payload.tenantId === tenantId;
      }),
    );
    return merge(filteredStream, heartbeat);
  }

  @Get('inbox/conversations/:id/messages')
  @UseGuards(JwtAuthGuard)
  getInboxMessages(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query('since') since?: string,
    @Query('refresh') refresh?: string,
    @Query('limit') limit?: string,
  ) {
    const forceRefresh = refresh === '1' || refresh === 'true';
    const parsedLimit = limit ? Number(limit) : undefined;
    return this.inbox.getMessages(
      id,
      since?.trim(),
      forceRefresh,
      Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      user.tenantId || undefined,
      user.id,
    );
  }

  @Post('inbox/messages/:messageId/resolve-media')
  @UseGuards(JwtAuthGuard)
  resolveInboxMessageMedia(@Param('messageId') messageId: string) {
    return this.inbox.resolveInboxMessageMedia(messageId);
  }

  @Get('inbox/conversations/:id/intent')
  @UseGuards(JwtAuthGuard)
  getInboxCustomerIntent(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query('auditId') auditId?: string,
  ) {
    return this.inbox.getCustomerIntent(id.trim(), auditId?.trim(), user.tenantId || undefined);
  }

  @Get('inbox/conversations/:id/ad-insights')
  @UseGuards(JwtAuthGuard)
  getInboxAdInsights(@CurrentUser() user: User, @Param('id') id: string) {
    return this.cskh.getConversationAdInsights(id.trim(), user.tenantId || undefined);
  }

  @Post('inbox/conversations/:id/send')
  @UseGuards(JwtAuthGuard)
  sendInboxMessage(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: { text?: string },
  ) {
    return this.inbox.sendMessage(id, body.text ?? '', user.tenantId || undefined);
  }

  @Post('inbox/conversations/:id/typing')
  @UseGuards(JwtAuthGuard)
  notifyInboxTyping(@CurrentUser() user: User, @Param('id') id: string) {
    return this.inbox.notifyTyping(id, user.tenantId || undefined);
  }

  @Post('inbox/conversations/:id/mark-as-read')
  @UseGuards(JwtAuthGuard)
  markInboxAsRead(@CurrentUser() user: User, @Param('id') id: string) {
    return this.inbox.markAsRead(id, user.tenantId || undefined, user.id);
  }

  @Post('inbox/sync')
  @UseGuards(JwtAuthGuard)
  syncInbox(
    @CurrentUser() user: User,
    @Body() body: { pageId?: string; full?: boolean },
  ) {
    return this.inbox.syncFromGraph(body.pageId?.trim(), user.tenantId || undefined, {
      full: body.full === true,
      lightweight: body.full !== true,
    });
  }

  /** Bắt đầu / tiếp tục "Quét đầy đủ" chạy nền. Tự bỏ qua kênh đã quét nếu có job paused. */
  @Post('inbox/backfill')
  @UseGuards(JwtAuthGuard)
  startBackfill(
    @CurrentUser() user: User,
    @Body() body: { scope?: 'empty' | 'all'; force?: boolean },
  ) {
    const scope = body.scope === 'empty' ? 'empty' : 'all';
    return this.inbox.startBackfill(scope, user.tenantId || undefined, {
      force: body.force === true,
    });
  }

  /** Tạm dừng quét — lưu tiến độ kênh đã xong vào DB. */
  @Post('inbox/backfill/pause')
  @UseGuards(JwtAuthGuard)
  pauseBackfill() {
    return this.inbox.requestBackfillPause();
  }

  /** Hủy toàn bộ quét — dừng ngay, xóa hàng đợi, không chờ xong kênh. */
  @Post('inbox/backfill/cancel')
  @UseGuards(JwtAuthGuard)
  cancelBackfill(@CurrentUser() user: User) {
    return this.inbox.cancelAllBackfill(user.tenantId || undefined);
  }

  /** Tiến độ "Quét đầy đủ" để FE hiển thị thanh tiến trình. */
  @Get('inbox/backfill')
  @UseGuards(JwtAuthGuard)
  getBackfillStatus(@CurrentUser() user: User) {
    return this.inbox.getBackfillStatus(user.tenantId || undefined);
  }

  @Post('inbox/link-audit')
  @UseGuards(JwtAuthGuard)
  linkAuditInbox(@CurrentUser() user: User, @Body() body: { auditId?: string }) {
    return this.inbox.linkFromAudit(body.auditId?.trim() ?? '', user.tenantId || undefined);
  }

  @Get('inbox/conversations/:id/audit-hint')
  @UseGuards(JwtAuthGuard)
  getInboxAuditHint(@CurrentUser() user: User, @Param('id') id: string) {
    return this.inbox.getLatestAuditForConversation(id, user.tenantId || undefined);
  }

  /** Proxy avatar Facebook CDN — public (img không gửi JWT). */
  @Get('media/avatar')
  proxyAvatar(@Req() req: Request, @Res() res: Response) {
    const url = parseMediaProxyUrlFromRequest(req.originalUrl || req.url || '', req.query.url);
    return this.cskh.proxyMediaUrl(url, res);
  }

  /** Proxy ảnh/video Facebook CDN — public. */
  @Get('media/proxy')
  proxyMedia(@Req() req: Request, @Res() res: Response) {
    const url = parseMediaProxyUrlFromRequest(req.originalUrl || req.url || '', req.query.url);
    return this.cskh.proxyMediaUrl(url, res);
  }

  /** Avatar Page — fetch Graph + stream (public). */
  @Get('media/page-avatar')
  pageAvatar(@Query('pageId') pageId: string, @Res() res: Response) {
    return this.cskh.streamPageAvatar(pageId, res);
  }

  /** Avatar khách — fetch Graph + stream (public). */
  @Get('media/customer-avatar')
  customerAvatar(
    @Query('pageId') pageId: string,
    @Query('psid') psid: string,
    @Res() res: Response,
  ) {
    return this.cskh.streamCustomerAvatar(pageId, psid, res);
  }

  @Get('dashboard/stats')
  @UseGuards(JwtAuthGuard)
  getDashboardStats(@CurrentUser() user: User) {
    return this.cskh.getDashboardStats(user.tenantId || undefined);
  }

  @Get('dashboard/heavy-stats')
  @UseGuards(JwtAuthGuard)
  getDashboardHeavyStats(@CurrentUser() user: User) {
    return this.cskh.getDashboardHeavyStats(user.tenantId || undefined);
  }
}
