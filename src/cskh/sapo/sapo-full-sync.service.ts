import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isSapoApiReady } from './sapo-api.util';
import { SapoProductImportService, type SapoProductImportResult } from './sapo-product-import.service';
import { SapoCustomerSyncService, type SapoCustomerSyncResult } from './sapo-customer-sync.service';
import { SapoOrderSyncService, type SapoOrderSyncResult } from './sapo-order-sync.service';
import {
  SapoCollectionSyncService,
  type SapoCollectionSyncResult,
} from './sapo-collection-sync.service';

export type SapoFullSyncResult = {
  ok: true;
  startedAt: string;
  finishedAt: string;
  products: SapoProductImportResult;
  customers: SapoCustomerSyncResult;
  collections: SapoCollectionSyncResult;
  orders: SapoOrderSyncResult;
};

export type SapoSyncResource = 'products' | 'customers' | 'orders' | 'collections' | 'all';

/**
 * Map Sapo Admin REST → bảng CRM:
 * - /admin/products.json          → products, product_variants, product_images, inventory_levels
 * - /admin/customers.json         → customers
 * - /admin/orders.json            → orders, order_items
 * - /admin/custom_collections.json (+ smart) → categories
 */
@Injectable()
export class SapoFullSyncService {
  private readonly logger = new Logger(SapoFullSyncService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly products: SapoProductImportService,
    private readonly customers: SapoCustomerSyncService,
    private readonly orders: SapoOrderSyncService,
    private readonly collections: SapoCollectionSyncService,
  ) {}

  isReady(): boolean {
    return isSapoApiReady(this.config);
  }

  async sync(resource: SapoSyncResource = 'all'): Promise<Partial<SapoFullSyncResult> & { ok: true; startedAt: string; finishedAt: string }> {
    if (!this.isReady()) {
      throw new Error('Chưa cấu hình Sapo (SAPO_STORE + API key/secret hoặc access token)');
    }

    const startedAt = new Date().toISOString();
    this.logger.log(`Sapo full sync start resource=${resource}`);

    const out: Partial<SapoFullSyncResult> & { ok: true; startedAt: string; finishedAt: string } = {
      ok: true,
      startedAt,
      finishedAt: startedAt,
    };

    // Thứ tự: products → customers → collections → orders (để map variant/customer)
    if (resource === 'all' || resource === 'products') {
      out.products = await this.products.importFromSapoApi();
    }
    if (resource === 'all' || resource === 'customers') {
      out.customers = await this.customers.syncFromSapo();
    }
    if (resource === 'all' || resource === 'collections') {
      out.collections = await this.collections.syncFromSapo();
    }
    if (resource === 'all' || resource === 'orders') {
      out.orders = await this.orders.syncFromSapo();
    }

    out.finishedAt = new Date().toISOString();
    this.logger.log(`Sapo full sync done resource=${resource}`);
    return out;
  }
}
