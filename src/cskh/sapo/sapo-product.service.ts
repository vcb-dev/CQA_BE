import { Injectable, Logger } from '@nestjs/common';
import { SapoCatalogDbService } from './sapo-catalog-db.service';
import { SapoProductImportService } from './sapo-product-import.service';

/** Một dòng catalog (từ bảng products) — dùng cho inbox chọn SP / tạo đơn. */
export type SapoCatalogVariant = {
  productId: number;
  variantId: number;
  productTitle: string;
  variantTitle: string;
  price: string;
  compareAtPrice: string | null;
  sku: string | null;
  tags: string;
  imageUrl: string | null;
  inventoryQuantity: number | null;
  category: string | null;
  material: string | null;
  unit: string | null;
};

export type SapoCatalogSource = 'db' | null;

@Injectable()
export class SapoProductService {
  private readonly logger = new Logger(SapoProductService.name);
  private cache: { at: number; items: SapoCatalogVariant[] } | null = null;
  private readonly cacheTtlMs = 15 * 60_000;

  constructor(
    private readonly catalogDb: SapoCatalogDbService,
    private readonly productImport: SapoProductImportService,
  ) {}

  isApiConfigured(): boolean {
    return false;
  }

  isConfigured(): boolean {
    return this.catalogDb.hasCatalog();
  }

  catalogSource(): SapoCatalogSource {
    if (this.cache?.items.length) return 'db';
    if (this.catalogDb.hasCatalog()) return 'db';
    return null;
  }

  authMode(): null {
    return null;
  }

  /** Catalog chỉ từ bảng products — không gọi Sapo API. */
  async getCatalog(force = false): Promise<SapoCatalogVariant[]> {
    if (!force && this.cache && Date.now() - this.cache.at < this.cacheTtlMs) {
      return this.cache.items;
    }

    const count = await this.catalogDb.refreshCount();
    if (count > 0) {
      const fromDb = await this.catalogDb.getCatalog();
      this.cache = { at: Date.now(), items: fromDb };
      return fromDb;
    }

    return [];
  }

  /** Import một lần từ Sapo API → bảng products (chỉ dùng khi admin bấm import). */
  async syncCatalogToDb() {
    const result = await this.productImport.importFromSapoApi();
    this.invalidateCache();
    await this.catalogDb.refreshCount();
    return {
      source: 'sapo_api' as const,
      fetched: result.variantsUpserted,
      upserted: result.variantsUpserted,
      productsUpserted: result.productsUpserted,
      productsFetched: result.productsFetched,
      unpublished: result.unpublished,
      deactivated: result.unpublished,
    };
  }

  invalidateCache(): void {
    this.cache = null;
  }
}
