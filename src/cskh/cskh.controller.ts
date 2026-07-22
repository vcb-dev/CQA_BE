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
  Logger,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import type { RawBodyRequest } from '@nestjs/common';
import { merge, interval, map, filter, Observable, tap, finalize } from 'rxjs';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CskhService } from './cskh.service';
import { CskhInsightService } from './cskh-insight.service';
import { CskhInboxService } from './inbox/cskh-inbox.service';
import { CskhInboxLabelsService } from './inbox/cskh-inbox-labels.service';
import {
  CskhInboxRealtimeService,
  type InboxRealtimePayload,
} from './inbox/cskh-inbox-realtime.service';
import { inboxRtLog, inboxRtWarn } from './inbox/inbox-realtime-debug.util';
import { RedisQueueService } from './redis/redis-queue.service';
import { verifyFacebookWebhookSignature } from './facebook/facebook-oauth.util';
import { parseMediaProxyUrlFromRequest } from './facebook/facebook-message.util';
import { SapoOAuthService } from './sapo/sapo-oauth.service';
import { SapoProductService } from './sapo/sapo-product.service';
import { SapoOrderService } from './sapo/sapo-order.service';
import { SapoFullSyncService, type SapoSyncResource } from './sapo/sapo-full-sync.service';
import { SapoDisplayService } from './sapo/sapo-display.service';
import { ProductAnalyticsService } from './product-analytics.service';
import { CustomerAnalyticsService } from './customer-analytics.service';
import { isSapoApiReady } from './sapo/sapo-api.util';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@ApiTags('cskh')
@ApiBearerAuth('JWT-auth')
@Controller('cskh')
export class CskhController {
  private readonly logger = new Logger(CskhController.name);

  constructor(
    private readonly cskh: CskhService,
    private readonly insights: CskhInsightService,
    private readonly inbox: CskhInboxService,
    private readonly inboxLabels: CskhInboxLabelsService,
    private readonly inboxRealtime: CskhInboxRealtimeService,
    private readonly redisQueue: RedisQueueService,
    private readonly sapoOAuth: SapoOAuthService,
    private readonly sapoProducts: SapoProductService,
    private readonly sapoOrders: SapoOrderService,
    private readonly sapoFullSync: SapoFullSyncService,
    private readonly sapoDisplay: SapoDisplayService,
    private readonly productAnalytics: ProductAnalyticsService,
    private readonly customerAnalytics: CustomerAnalyticsService,
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
    const catalogSource = this.sapoProducts.catalogSource();
    const ordersReady = this.sapoOrders.isConfigured();
    const catalog = await this.sapoProducts.getCatalog();
    const variantCount = catalog.length;
    const apiReady = isSapoApiReady(this.configService);

    return {
      oauthReady: false,
      apiReady,
      syncReady: apiReady,
      ordersReady,
      dbCatalogReady: variantCount > 0,
      catalogSource: catalogSource ?? (variantCount > 0 ? 'db' : null),
      authMode: null,
      redirectUri: null,
      authorizeUrl: null,
      oauthStartUrl: null,
      variantCount,
      mode: apiReady ? 'api+db' : 'db_only',
      resources: {
        products: 'products / product_variants / product_images / inventory_levels',
        customers: 'customers',
        orders: 'orders / order_items',
        collections: 'categories',
      },
    };
  }

  /**
   * Kéo data Sapo → DB CRM.
   * body/query resource: all | products | customers | orders | collections
   */
  @Post('sapo/sync')
  @UseGuards(JwtAuthGuard)
  async sapoSync(
    @Query('resource') resourceQuery?: string,
    @Body() body?: { resource?: string },
  ) {
    const raw = (body?.resource ?? resourceQuery ?? 'all').trim().toLowerCase();
    const allowed: SapoSyncResource[] = ['all', 'products', 'customers', 'orders', 'collections'];
    if (!allowed.includes(raw as SapoSyncResource)) {
      throw new BadRequestException(`resource phải là: ${allowed.join(', ')}`);
    }
    try {
      return await this.sapoFullSync.sync(raw as SapoSyncResource);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Sapo sync failed';
      throw new BadRequestException(msg);
    }
  }

  @Post('sapo/sync/products')
  @UseGuards(JwtAuthGuard)
  async sapoSyncProducts() {
    try {
      return await this.sapoFullSync.sync('products');
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'Sapo sync products failed');
    }
  }

  @Post('sapo/sync/customers')
  @UseGuards(JwtAuthGuard)
  async sapoSyncCustomers() {
    try {
      return await this.sapoFullSync.sync('customers');
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'Sapo sync customers failed');
    }
  }

  @Post('sapo/sync/orders')
  @UseGuards(JwtAuthGuard)
  async sapoSyncOrders() {
    try {
      return await this.sapoFullSync.sync('orders');
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'Sapo sync orders failed');
    }
  }

  @Post('sapo/sync/collections')
  @UseGuards(JwtAuthGuard)
  async sapoSyncCollections() {
    try {
      return await this.sapoFullSync.sync('collections');
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'Sapo sync collections failed');
    }
  }

  /** Bảng Sapo đã flatten — phục vụ UI */
  @Get('sapo/display/stats')
  @UseGuards(JwtAuthGuard)
  sapoDisplayStats() {
    return this.sapoDisplay.stats();
  }

  @Get('sapo/display/customers')
  @UseGuards(JwtAuthGuard)
  sapoDisplayCustomers(
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.sapoDisplay.listCustomers({
      q,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
  }

  @Get('sapo/display/orders')
  @UseGuards(JwtAuthGuard)
  sapoDisplayOrders(
    @Query('q') q?: string,
    @Query('financialStatus') financialStatus?: string,
    @Query('fulfillmentStatus') fulfillmentStatus?: string,
    @Query('sapoStatus') sapoStatus?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.sapoDisplay.listOrders({
      q,
      financialStatus,
      fulfillmentStatus,
      sapoStatus,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
  }

  @Get('sapo/catalog')
  @UseGuards(JwtAuthGuard)
  async sapoCatalog() {
    const items = await this.sapoProducts.getCatalog();
    return {
      source: this.sapoProducts.catalogSource(),
      items: items.map((v) => {
        const variantTitle =
          v.variantTitle && !/^default/i.test(v.variantTitle) ? v.variantTitle : '';
        // Tên SP sạch; size/màu tách riêng ở variantTitle để FE gắn nhãn Size/Màu.
        const name = v.productTitle;
        const price = parseFloat(v.price) || 0;
        return {
          productId: v.productId,
          variantId: v.variantId,
          name,
          productTitle: v.productTitle,
          variantTitle,
          category: v.category,
          material: v.material,
          unit: v.unit,
          price,
          priceLabel: `${Math.round(price).toLocaleString('vi-VN')}đ`,
          sku: v.sku,
          imageUrl: v.imageUrl,
          inStock: v.inventoryQuantity == null ? true : v.inventoryQuantity > 0,
          inventoryQuantity: v.inventoryQuantity,
        };
      }),
    };
  }

  @Post('sapo/catalog/sync')
  @UseGuards(JwtAuthGuard)
  async sapoCatalogSync() {
    return this.sapoProducts.syncCatalogToDb();
  }

  /** Dashboard analytics sản phẩm từ DB (catalog + đơn inbox). */
  @Get('products/analytics')
  @UseGuards(JwtAuthGuard)
  getProductsAnalytics(
    @Query('q') q?: string,
    @Query('category') category?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.productAnalytics.getDashboard({
      q,
      category,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
  }

  /** Danh sách khách đã chốt đơn inbox — filter theo kênh (page) / trạng thái hội thoại. */
  @Get('customers')
  @UseGuards(JwtAuthGuard)
  listCustomers(
    @CurrentUser() user: User,
    @Query('q') q?: string,
    @Query('pageId') pageId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.customerAnalytics.listCustomers({
      tenantId: user.tenantId || undefined,
      q,
      pageId,
      status,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
  }

  /** Import sản phẩm từ Sapo API → bảng products / product_variants. */
  @Post('products/import-from-sapo')
  @UseGuards(JwtAuthGuard)
  async importProductsFromSapo() {
    return this.sapoProducts.syncCatalogToDb();
  }

  @Post('sapo/orders')
  @UseGuards(JwtAuthGuard)
  createSapoOrder(
    @Body()
    body: {
      customerName?: string;
      phone?: string;
      address?: string;
      note?: string;
      psid?: string;
      conversationId?: string;
      lineItems?: Array<{ variantId?: number; quantity?: number }>;
    },
  ) {
    const lineItems = (body.lineItems ?? [])
      .map((item) => ({
        variantId: Number(item.variantId),
        quantity: Number(item.quantity ?? 1),
      }))
      .filter((item) => Number.isFinite(item.variantId) && item.variantId > 0);

    return this.sapoOrders.createOrder({
      customerName: (body.customerName ?? '').trim() || 'Khách Messenger',
      phone: body.phone,
      address: body.address,
      note: body.note,
      psid: body.psid,
      conversationId: body.conversationId,
      lineItems,
    });
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
      this.logger.warn(
        `[audit] Redis queue unavailable — chạy inline trên API (job ${job.id.slice(0, 8)})`,
      );
      void this.cskh.runAuditJob(job.id, auditOptions);
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
    const userId = user.id.toString();
    inboxRtLog('SSE client subscribed', {
      userId,
      email: user.email,
      tenantId: tenantId ?? null,
    });
    const filteredStream = this.inboxRealtime.stream().pipe(
      filter((event) => {
        const payload = event.data as InboxRealtimePayload | undefined;
        if (!payload || payload.type === 'ping') return false;
        if (!payload.tenantId || !tenantId) return true;
        if (payload.tenantId === tenantId) return true;
        inboxRtWarn('SSE event blocked (tenant mismatch)', {
          userId,
          userTenantId: tenantId ?? null,
          eventTenantId: payload.tenantId,
          type: payload.type,
          conversationId: payload.conversationId,
        });
        return false;
      }),
      tap((event) => {
        const payload = event.data as InboxRealtimePayload;
        const lastMsg = payload.messages?.[payload.messages.length - 1];
        const messageLagMs =
          lastMsg?.sentAt != null ? Date.now() - new Date(lastMsg.sentAt).getTime() : undefined;
        inboxRtLog('SSE out → browser', {
          userId,
          type: payload.type,
          conversationId: payload.conversationId,
          messagePreview: lastMsg?.text?.slice(0, 80),
          messageSentAt: lastMsg?.sentAt,
          lastMessageAt: payload.conversation?.lastMessageAt,
          messageLagMs,
        });
      }),
    );
    return merge(filteredStream, heartbeat).pipe(
      finalize(() => {
        inboxRtLog('SSE client disconnected', { userId, email: user.email });
      }),
    );
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
  getInboxAdInsights(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query('refresh') refresh?: string,
  ) {
    const bypassCache = refresh === 'true';
    return this.cskh.getConversationAdInsights(id.trim(), user.tenantId || undefined, bypassCache);
  }

  @Post('inbox/conversations/:id/send')
  @UseGuards(JwtAuthGuard)
  sendInboxMessage(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: { text?: string; autoTranslate?: boolean },
  ) {
    return this.inbox.sendMessage(id, body.text ?? '', user.tenantId || undefined, {
      autoTranslate: Boolean(body.autoTranslate),
    });
  }

  @Post('inbox/conversations/:id/translate-preview')
  @UseGuards(JwtAuthGuard)
  translateInboxPreview(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: { text?: string; targetLang?: string },
  ) {
    return this.inbox.translatePreview(
      id,
      body.text ?? '',
      user.tenantId || undefined,
      body.targetLang,
    );
  }

  @Post('inbox/conversations/:id/detect-lang')
  @UseGuards(JwtAuthGuard)
  detectInboxLang(@CurrentUser() user: User, @Param('id') id: string) {
    return this.inbox.detectAndPersistCustomerLang(id, user.tenantId || undefined);
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

  @Post('inbox/conversations/:id/mark-as-unread')
  @UseGuards(JwtAuthGuard)
  markInboxAsUnread(@CurrentUser() user: User, @Param('id') id: string) {
    return this.inbox.markAsUnread(id, user.tenantId || undefined);
  }

  @Post('inbox/sync')
  @UseGuards(JwtAuthGuard)
  syncInbox(
    @CurrentUser() user: User,
    @Body() body: { pageId?: string; full?: boolean },
  ) {
    const pageId = body.pageId?.trim();
    const tenantId = user.tenantId || undefined;
    const options = { full: body.full === true, lightweight: body.full !== true };

    // Quét nhiều kênh — chạy nền, không block HTTP (tránh treo web)
    if (!pageId) {
      void this.inbox.syncFromGraph(undefined, tenantId, options).catch(() => undefined);
      return {
        started: true,
        syncing: true,
        message: 'Đang đồng bộ nền — làm mới danh sách sau vài phút',
      };
    }

    return this.inbox.syncFromGraph(pageId, tenantId, options);
  }

  /** Bắt đầu / tiếp tục "Quét đầy đủ" chạy nền. Tự bỏ qua kênh đã quét nếu có job paused. */
  @Post('inbox/backfill')
  @UseGuards(JwtAuthGuard)
  startBackfill(
    @CurrentUser() user: User,
    @Body() body: { scope?: 'empty' | 'all'; force?: boolean; date?: string },
  ) {
    const scope = body.scope === 'empty' ? 'empty' : 'all';
    const date = body.date?.trim();
    return this.inbox.startBackfill(scope, user.tenantId || undefined, {
      force: body.force === true,
      date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
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
