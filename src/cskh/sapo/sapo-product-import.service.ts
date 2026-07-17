import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  isSapoApiReady,
  resolveSapoApiAuth,
  resolveSapoStoreHost,
  sapoAxiosConfig,
} from './sapo-api.util';
import {
  extractNameMarkers,
  normalizeUnit,
  parseSapoDate,
  parseSapoProductType,
  parseSapoTags,
  resolveProductSlug,
  resolveVariantSku,
  stripHtml,
  variantDisplayTitle,
  type SapoImportProduct,
} from './sapo-product-import.util';

export type SapoProductImportResult = {
  source: 'sapo_api';
  productsFetched: number;
  productsUpserted: number;
  variantsUpserted: number;
  unpublished: number;
};

@Injectable()
export class SapoProductImportService {
  private readonly logger = new Logger(SapoProductImportService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  isReady(): boolean {
    return isSapoApiReady(this.config);
  }

  /** Gọi Sapo GET /admin/products.json → lưu vào products + product_variants (+ ảnh, tồn kho). */
  async importFromSapoApi(): Promise<SapoProductImportResult> {
    if (!this.isReady()) {
      throw new Error('Chưa cấu hình Sapo (SAPO_STORE + API key/secret hoặc access token)');
    }

    const products = await this.fetchAllSapoProducts();
    if (!products.length) {
      throw new Error('Sapo không trả sản phẩm — kiểm tra quyền read_products');
    }

    const warehouseId = await this.resolveDefaultWarehouseId();
    const importedSlugs: string[] = [];
    let productsUpserted = 0;
    let variantsUpserted = 0;

    for (const raw of products) {
      const sapoId = raw.id ?? 0;
      const rawName = (raw.name ?? raw.title ?? '').trim();
      if (!sapoId || !rawName) continue;

      const { name, craftType, isDiscontinued } = extractNameMarkers(rawName);

      const slug = await this.ensureUniqueSlug(resolveProductSlug(raw.alias, name, sapoId), sapoId);
      importedSlugs.push(slug);

      const tags = parseSapoTags(raw.tags);
      const primaryImage = raw.image?.src ?? raw.images?.[0]?.src ?? null;
      const isPublished = (raw.status ?? 'active').toLowerCase() === 'active';
      const { category, material } = parseSapoProductType(raw.product_type);
      const unit = normalizeUnit(raw.variants?.[0]?.unit);
      const productTypeRaw = raw.product_type?.trim() || null;
      const shortDescription = stripHtml(raw.summary);
      const seoTitle = raw.meta_title?.trim() || null;
      const seoDescription = raw.meta_description?.trim() || null;
      const taxIndustryGroup = raw.vat_pit_category_code?.trim() || null;
      const publishedAt = parseSapoDate(raw.published_on);
      const sapoCreatedAt = parseSapoDate(raw.created_on);
      const sapoUpdatedAt = parseSapoDate(raw.modified_on);

      const product = await this.prisma.product.upsert({
        where: { slug },
        create: {
          sapoId: BigInt(sapoId),
          slug,
          name,
          brand: raw.vendor?.trim() || null,
          category,
          material,
          craftType,
          isDiscontinued,
          productType: productTypeRaw,
          unit,
          tags,
          requiresShipping: true,
          isPublished,
          taxable: true,
          imageUrl: primaryImage,
          description: stripHtml(raw.content),
          shortDescription,
          seoTitle,
          seoDescription,
          taxIndustryGroup,
          publishedAt,
          sapoCreatedAt,
          sapoUpdatedAt,
          trackInventory: true,
          salesChannels: { create: [{ channel: 'sapo' }] },
        },
        update: {
          sapoId: BigInt(sapoId),
          name,
          brand: raw.vendor?.trim() || null,
          category,
          material,
          craftType,
          isDiscontinued,
          productType: productTypeRaw,
          unit,
          tags,
          isPublished,
          imageUrl: primaryImage,
          description: stripHtml(raw.content),
          shortDescription,
          seoTitle,
          seoDescription,
          taxIndustryGroup,
          publishedAt,
          sapoCreatedAt,
          sapoUpdatedAt,
        },
      });
      productsUpserted++;

      await this.syncProductImages(product.id, raw);
      await this.ensureSalesChannel(product.id);

      const imageById = new Map(
        (raw.images ?? []).filter((i) => i.id).map((i) => [i.id!, i.src ?? null]),
      );

      for (const v of raw.variants ?? []) {
        const sapoVariantId = v.id ?? 0;
        if (!sapoVariantId) continue;

        const sku = await this.ensureUniqueSku(resolveVariantSku(v.sku, sapoVariantId), sapoVariantId);
        const variantTitle = variantDisplayTitle(v);
        const variantImage =
          v.image_id != null ? imageById.get(v.image_id) ?? primaryImage : primaryImage;
        const qty = typeof v.inventory_quantity === 'number' ? v.inventory_quantity : 0;
        const price = new Prisma.Decimal(String(v.price ?? '0'));
        const compareAt =
          v.compare_at_price != null && v.compare_at_price !== ''
            ? new Prisma.Decimal(String(v.compare_at_price))
            : null;

        const variant = await this.prisma.productVariant.upsert({
          where: { sku },
          create: {
            productId: product.id,
            sku,
            title: variantTitle,
            barcode: v.barcode?.trim() || null,
            price,
            compareAtPrice: compareAt,
            weight: v.weight != null ? new Prisma.Decimal(String(v.weight)) : null,
            weightUnit: v.weight_unit?.trim() || null,
            unit: normalizeUnit(v.unit),
            imageUrl: variantImage,
            enabled: isPublished,
          },
          update: {
            productId: product.id,
            title: variantTitle,
            barcode: v.barcode?.trim() || null,
            price,
            compareAtPrice: compareAt,
            weight: v.weight != null ? new Prisma.Decimal(String(v.weight)) : null,
            weightUnit: v.weight_unit?.trim() || null,
            unit: normalizeUnit(v.unit),
            imageUrl: variantImage,
            enabled: isPublished,
          },
        });
        variantsUpserted++;

        if (warehouseId != null) {
          await this.prisma.inventoryLevel.upsert({
            where: {
              variantId_warehouseId: { variantId: variant.id, warehouseId },
            },
            create: {
              variantId: variant.id,
              warehouseId,
              onHand: qty,
              available: qty,
              price,
            },
            update: {
              onHand: qty,
              available: qty,
              price,
            },
          });
        }
      }
    }

    const unpublished = await this.prisma.product.updateMany({
      where: {
        isPublished: true,
        salesChannels: { some: { channel: 'sapo' } },
        slug: { notIn: importedSlugs },
      },
      data: { isPublished: false },
    });

    this.logger.log(
      `Sapo → products import: ${products.length} SP, ${variantsUpserted} variants, unpublished=${unpublished.count}`,
    );

    return {
      source: 'sapo_api',
      productsFetched: products.length,
      productsUpserted,
      variantsUpserted,
      unpublished: unpublished.count,
    };
  }

  private async fetchAllSapoProducts(): Promise<SapoImportProduct[]> {
    const host = resolveSapoStoreHost(this.config)!;
    const auth = resolveSapoApiAuth(this.config)!;
    const baseUrl = `https://${host}/admin/products.json`;
    const all: SapoImportProduct[] = [];

    for (let page = 1; page <= 60; page++) {
      const { data } = await axios.get<{ products?: SapoImportProduct[] }>(baseUrl, {
        ...sapoAxiosConfig(auth),
        params: { limit: 250, page },
        timeout: 60_000,
      });
      const batch = data.products ?? [];
      if (!batch.length) break;
      all.push(...batch);
      if (batch.length < 250) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    return all;
  }

  private async ensureUniqueSlug(base: string, sapoId: number): Promise<string> {
    const taken = await this.prisma.product.findUnique({ where: { slug: base } });
    if (!taken) return base;
    const suffixed = `${base}-${sapoId}`.slice(0, 200);
    const taken2 = await this.prisma.product.findUnique({ where: { slug: suffixed } });
    if (!taken2) return suffixed;
    return base;
  }

  private async ensureUniqueSku(base: string, sapoVariantId: number): Promise<string> {
    const existing = await this.prisma.productVariant.findUnique({ where: { sku: base } });
    if (!existing) return base;
    return `SP-${sapoVariantId}`;
  }

  private async syncProductImages(productId: bigint, raw: SapoImportProduct): Promise<void> {
    const images = raw.images ?? [];
    if (!images.length && raw.image?.src) {
      await this.prisma.productImage.deleteMany({ where: { productId } });
      await this.prisma.productImage.create({
        data: { productId, url: raw.image.src, position: 0, isPrimary: true },
      });
      return;
    }
    if (!images.length) return;

    await this.prisma.productImage.deleteMany({ where: { productId } });
    await this.prisma.productImage.createMany({
      data: images
        .filter((img) => img.src)
        .map((img, idx) => ({
          productId,
          url: img.src!,
          position: img.position ?? idx,
          isPrimary: idx === 0,
        })),
    });
  }

  private async ensureSalesChannel(productId: bigint): Promise<void> {
    await this.prisma.productSalesChannel.upsert({
      where: { productId_channel: { productId, channel: 'sapo' } },
      create: { productId, channel: 'sapo' },
      update: {},
    });
  }

  private async resolveDefaultWarehouseId(): Promise<bigint | null> {
    const wh = await this.prisma.warehouse.findFirst({
      where: { isActive: true },
      orderBy: { id: 'asc' },
    });
    return wh?.id ?? null;
  }
}
