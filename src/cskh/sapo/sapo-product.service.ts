import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/** Một variant Sapo — phẳng hoá để match nhanh. */
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
};

type SapoProductJson = {
  id?: number;
  title?: string;
  tags?: string;
  variants?: Array<{
    id?: number;
    title?: string;
    price?: string;
    compare_at_price?: string | null;
    sku?: string | null;
    inventory_quantity?: number | null;
    image_id?: number | null;
  }>;
  images?: Array<{ id?: number; src?: string }>;
};

@Injectable()
export class SapoProductService {
  private readonly logger = new Logger(SapoProductService.name);
  private cache: { at: number; items: SapoCatalogVariant[] } | null = null;
  private readonly cacheTtlMs = 15 * 60_000;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.storeHost() && this.accessToken());
  }

  private storeHost(): string | null {
    const raw = (this.config.get<string>('SAPO_STORE') ?? '').trim();
    if (!raw) return null;
    if (raw.includes('mysapo.net')) return raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `${raw.replace(/\.mysapo\.net$/i, '')}.mysapo.net`;
  }

  private accessToken(): string | null {
    const token = (this.config.get<string>('SAPO_ACCESS_TOKEN') ?? '').trim();
    return token || null;
  }

  /** Lấy catalog Sapo — paginate tối đa 10 trang × 250 SP. */
  async getCatalog(force = false): Promise<SapoCatalogVariant[]> {
    if (!this.isConfigured()) return [];
    if (!force && this.cache && Date.now() - this.cache.at < this.cacheTtlMs) {
      return this.cache.items;
    }

    const host = this.storeHost()!;
    const token = this.accessToken()!;
    const items: SapoCatalogVariant[] = [];
    const baseUrl = `https://${host}/admin/products.json`;

    try {
      for (let page = 1; page <= 10; page++) {
        const { data } = await axios.get<{ products?: SapoProductJson[] }>(baseUrl, {
          headers: {
            'Content-Type': 'application/json',
            'X-Sapo-Access-Token': token,
          },
          params: { limit: 250, page },
          timeout: 30_000,
        });

        const products = data.products ?? [];
        if (!products.length) break;

        for (const p of products) {
          const productId = p.id ?? 0;
          const productTitle = (p.title ?? '').trim();
          const tags = (p.tags ?? '').trim();
          const images = p.images ?? [];
          const imageById = new Map(images.filter((i) => i.id).map((i) => [i.id!, i.src ?? null]));

          for (const v of p.variants ?? []) {
            const variantId = v.id ?? 0;
            if (!productId || !variantId) continue;
            const imageUrl =
              v.image_id != null ? (imageById.get(v.image_id) ?? images[0]?.src ?? null) : images[0]?.src ?? null;
            items.push({
              productId,
              variantId,
              productTitle,
              variantTitle: (v.title ?? 'Default').trim(),
              price: String(v.price ?? '0'),
              compareAtPrice: v.compare_at_price ?? null,
              sku: v.sku ?? null,
              tags,
              imageUrl,
              inventoryQuantity:
                typeof v.inventory_quantity === 'number' ? v.inventory_quantity : null,
            });
          }
        }

        if (products.length < 250) break;
        await new Promise((r) => setTimeout(r, 550));
      }

      this.cache = { at: Date.now(), items };
      this.logger.log(`Sapo catalog loaded: ${items.length} variants`);
      return items;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Sapo products fetch failed: ${msg}`);
      return this.cache?.items ?? [];
    }
  }
}
