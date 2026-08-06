import { Module } from '@nestjs/common';
import { CskhController } from './cskh.controller';
import { CskhService } from './cskh.service';
import { CskhInsightService } from './cskh-insight.service';
import { CskhInboxService } from './inbox/cskh-inbox.service';
import { CskhInboxLabelsService } from './inbox/cskh-inbox-labels.service';
import { CskhInboxRealtimeService } from './inbox/cskh-inbox-realtime.service';
import { FacebookGraphService } from './facebook/facebook-graph.service';
import { FacebookAdsService } from './facebook/facebook-ads.service';
import { SapoProductService } from './sapo/sapo-product.service';
import { SapoProductImportService } from './sapo/sapo-product-import.service';
import { SapoOAuthService } from './sapo/sapo-oauth.service';
import { SapoCatalogDbService } from './sapo/sapo-catalog-db.service';
import { SapoOrderService } from './sapo/sapo-order.service';
import { SapoFullSyncService } from './sapo/sapo-full-sync.service';
import { SapoCustomerSyncService } from './sapo/sapo-customer-sync.service';
import { SapoOrderSyncService } from './sapo/sapo-order-sync.service';
import { SapoCollectionSyncService } from './sapo/sapo-collection-sync.service';
import { SapoDisplayService } from './sapo/sapo-display.service';
import { ProductAnalyticsService } from './product-analytics.service';
import { OmsApiService } from './oms/oms-api.service';
import { OmsCatalogService } from './oms/oms-catalog.service';
import { OmsProductOperationsService } from './oms/oms-product-operations.service';
import { CustomerAnalyticsService } from './customer-analytics.service';
import { CskhCronService } from './cskh-cron.service';
import { GraphApiCoordinatorService } from './facebook/graph-api-coordinator.service';
import { CskhRedisSignalsService } from './redis/cskh-redis-signals.service';
import { RedisQueueService } from './redis/redis-queue.service';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AiModule, AuthModule, UsersModule],
  controllers: [CskhController],
  providers: [
    CskhRedisSignalsService,
    GraphApiCoordinatorService,
    CskhService,
    CskhInsightService,
    CskhInboxService,
    CskhInboxLabelsService,
    CskhInboxRealtimeService,
    FacebookGraphService,
    FacebookAdsService,
    SapoProductService,
    SapoCatalogDbService,
    SapoProductImportService,
    SapoOAuthService,
    SapoOrderService,
    SapoCustomerSyncService,
    SapoOrderSyncService,
    SapoCollectionSyncService,
    SapoFullSyncService,
    SapoDisplayService,
    ProductAnalyticsService,
    OmsApiService,
    OmsCatalogService,
    OmsProductOperationsService,
    CustomerAnalyticsService,
    CskhCronService,
    RedisQueueService,
  ],
  exports: [CskhService, CskhInboxService, RedisQueueService],
})
export class CskhModule {}
