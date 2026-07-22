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

    const warehouseId = await this.resolveDefaultWarehouseId();
    const existingIds = new Set<number>(
      (
        await this.prisma.product.findMany({
          where: { sapoId: { not: null } },
          select: { sapoId: true },
        })
      )
        .map((r) => Number(r.sapoId))
        .filter((n) => Number.isFinite(n) && n > 0),
    );
    this.logger.log(`Products sync: ${existingIds.size} already in DB — skip những SP đã có`);

    const importedSlugs: string[] = [];
    // Giữ slug đã có để bước unpublish không xóa nhầm
    const existingSlugs = await this.prisma.product.findMany({
      where: { sapoId: { not: null } },
      select: { slug: true },
    });
    for (const r of existingSlugs) importedSlugs.push(r.slug);

    let productsFetched = 0;
    let productsUpserted = 0;
    let productsSkipped = 0;
    let variantsUpserted = 0;

    for await (const batch of this.iterateSapoProductPages(null)) {
      productsFetched += batch.length;
      for (const raw of batch) {
        const sapoId = raw.id ?? 0;
        if (!sapoId) continue;
        if (existingIds.has(sapoId)) {
          productsSkipped++;
          continue;
        }

        const result = await this.createNewProductFastWithRetry(raw, warehouseId);
        if (!result) {
          // Có thể P2002 — đánh dấu để lần sau skip
          existingIds.add(sapoId);
          productsSkipped++;
          continue;
        }
        importedSlugs.push(result.slug);
        existingIds.add(sapoId);
        productsUpserted++;
        variantsUpserted += result.variantsUpserted;

        if (productsUpserted % 25 === 0) {
          this.logger.log(
            `Sapo products progress: fetched=${productsFetched} upserted=${productsUpserted} skipped=${productsSkipped} variants=${variantsUpserted}`,
          );
        }
      }
      this.logger.log(
        `Sapo products page done: fetched=${productsFetched} upserted=${productsUpserted} skipped=${productsSkipped} variants=${variantsUpserted}`,
      );
    }

    let unpublished = 0;
    // Chỉ unpublish khi đã quét được khá nhiều (tránh unpublish hàng loạt nếu fetch lỗi sớm)
    if (productsFetched >= 1000) {
      const result = await this.prisma.product.updateMany({
        where: {
          isPublished: true,
          salesChannels: { some: { channel: 'sapo' } },
          slug: { notIn: importedSlugs },
        },
        data: { isPublished: false },
      });
      unpublished = result.count;
    }

    if (!productsFetched) {
      throw new Error('Sapo không trả sản phẩm — kiểm tra quyền read_products');
    }

    this.logger.log(
      `Sapo → products import: fetched=${productsFetched} upserted=${productsUpserted} skipped=${productsSkipped} variants=${variantsUpserted} unpublished=${unpublished}`,
    );

    return {
      source: 'sapo_api',
      productsFetched,
      productsUpserted,
      variantsUpserted,
      unpublished,
    };
  }

  private async createNewProductFastWithRetry(
    raw: SapoImportProduct,
    warehouseId: bigint | null,
    attempt = 1,
  ): Promise<{ slug: string; variantsUpserted: number } | null> {
    try {
      return await this.createNewProductFast(raw, warehouseId);
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      // Đã có (race / sync song song) → coi như skip
      if (code === 'P2002') {
        this.logger.warn(`product sapoId=${raw.id} already exists — skip`);
        return null;
      }
      if ((code === 'P1017' || code === 'P2024') && attempt < 6) {
        const wait = attempt * 1500;
        this.logger.warn(`product create retry ${attempt} (${code}) wait ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        return this.createNewProductFastWithRetry(raw, warehouseId, attempt + 1);
      }
      this.logger.error(
        `product sapoId=${raw.id} failed: ${e instanceof Error ? e.message : e}`,
      );
      return null;
    }
  }

  /** Insert SP mới trong 1 query nested — nhanh hơn upsert từng variant. */
  private async createNewProductFast(
    raw: SapoImportProduct,
    warehouseId: bigint | null,
  ): Promise<{ slug: string; variantsUpserted: number } | null> {
    const sapoId = raw.id ?? 0;
    const rawName = (raw.name ?? raw.title ?? '').trim();
    if (!sapoId || !rawName) return null;

    const { name, craftType, isDiscontinued } = extractNameMarkers(rawName);
    const slug = `sapo-${sapoId}`;
    const tags = parseSapoTags(raw.tags);
    const primaryImage = raw.image?.src ?? raw.images?.[0]?.src ?? null;
    const isPublished = (raw.status ?? 'active').toLowerCase() === 'active';
    const { category, material } = parseSapoProductType(raw.product_type);
    const unit = normalizeUnit(raw.variants?.[0]?.unit);
    const imageById = new Map(
      (raw.images ?? []).filter((i) => i.id).map((i) => [i.id!, i.src ?? null]),
    );

    const variantCreates = (raw.variants ?? [])
      .filter((v) => v.id)
      .map((v) => {
        const sapoVariantId = v.id!;
        const qty = typeof v.inventory_quantity === 'number' ? v.inventory_quantity : 0;
        const price = new Prisma.Decimal(String(v.price ?? '0'));
        const compareAt =
          v.compare_at_price != null && v.compare_at_price !== ''
            ? new Prisma.Decimal(String(v.compare_at_price))
            : null;
        const variantImage =
          v.image_id != null ? imageById.get(v.image_id) ?? primaryImage : primaryImage;

        return {
          sapoId: BigInt(sapoVariantId),
          sku: `SAPO-V-${sapoVariantId}`,
          title: variantDisplayTitle(v),
          barcode: v.barcode?.trim() || null,
          price,
          compareAtPrice: compareAt,
          weight: v.weight != null ? new Prisma.Decimal(String(v.weight)) : null,
          weightUnit: v.weight_unit?.trim() || null,
          unit: normalizeUnit(v.unit),
          imageUrl: variantImage,
          enabled: isPublished,
          ...(warehouseId != null
            ? {
                inventoryLevels: {
                  create: [
                    {
                      warehouseId,
                      onHand: qty,
                      available: qty,
                      price,
                    },
                  ],
                },
              }
            : {}),
        };
      });

    const images = (raw.images ?? [])
      .filter((img) => img.src)
      .map((img, idx) => ({
        url: img.src!,
        position: img.position ?? idx,
        isPrimary: idx === 0,
      }));
    if (!images.length && primaryImage) {
      images.push({ url: primaryImage, position: 0, isPrimary: true });
    }

    await this.prisma.product.create({
      data: {
        sapoId: BigInt(sapoId),
        slug,
        name,
        brand: raw.vendor?.trim() || null,
        category,
        material,
        craftType,
        isDiscontinued,
        productType: raw.product_type?.trim() || null,
        unit,
        tags,
        requiresShipping: true,
        isPublished,
        taxable: true,
        imageUrl: primaryImage,
        description: stripHtml(raw.content),
        shortDescription: stripHtml(raw.summary),
        seoTitle: raw.meta_title?.trim() || null,
        seoDescription: raw.meta_description?.trim() || null,
        taxIndustryGroup: raw.vat_pit_category_code?.trim() || null,
        publishedAt: parseSapoDate(raw.published_on),
        sapoCreatedAt: parseSapoDate(raw.created_on),
        sapoUpdatedAt: parseSapoDate(raw.modified_on),
        trackInventory: true,
        salesChannels: { create: [{ channel: 'sapo' }] },
        ...(images.length ? { images: { create: images } } : {}),
        ...(variantCreates.length ? { variants: { create: variantCreates } } : {}),
      },
    });

    return { slug, variantsUpserted: variantCreates.length };
  }

  private async upsertOneProductWithRetry(
    raw: SapoImportProduct,
    warehouseId: bigint | null,
    attempt = 1,
  ): Promise<{ slug: string; variantsUpserted: number } | null> {
    try {
      return await this.upsertOneProduct(raw, warehouseId);
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if ((code === 'P1017' || code === 'P2024') && attempt < 6) {
        const wait = attempt * 2000;
        this.logger.warn(`product upsert retry ${attempt} (${code}) wait ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        return this.upsertOneProductWithRetry(raw, warehouseId, attempt + 1);
      }
      throw e;
    }
  }

  private async upsertOneProduct(
    raw: SapoImportProduct,
    warehouseId: bigint | null,
  ): Promise<{ slug: string; variantsUpserted: number } | null> {
    const sapoId = raw.id ?? 0;
    const rawName = (raw.name ?? raw.title ?? '').trim();
    if (!sapoId || !rawName) return null;

    const { name, craftType, isDiscontinued } = extractNameMarkers(rawName);

    const slug = await this.ensureUniqueSlug(resolveProductSlug(raw.alias, name, sapoId), sapoId);

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

    const existingBySapo = await this.prisma.product.findUnique({
      where: { sapoId: BigInt(sapoId) },
    });

    const baseData = {
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
    };

    const product = existingBySapo
      ? await this.prisma.product.update({
          where: { id: existingBySapo.id },
          data: baseData,
        })
      : await this.prisma.product.upsert({
          where: { slug },
          create: {
            ...baseData,
            salesChannels: { create: [{ channel: 'sapo' }] },
          },
          update: baseData,
        });

    await this.syncProductImages(product.id, raw);
    await this.ensureSalesChannel(product.id);

    const imageById = new Map(
      (raw.images ?? []).filter((i) => i.id).map((i) => [i.id!, i.src ?? null]),
    );

    let variantsUpserted = 0;
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

      const existingVariant = await this.prisma.productVariant.findUnique({
        where: { sapoId: BigInt(sapoVariantId) },
      });

      const variantData = {
        productId: product.id,
        sapoId: BigInt(sapoVariantId),
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
      };

      const variant = existingVariant
        ? await this.prisma.productVariant.update({
            where: { id: existingVariant.id },
            data: variantData,
          })
        : await this.prisma.productVariant.upsert({
            where: { sku },
            create: variantData,
            update: variantData,
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

    return { slug, variantsUpserted };
  }

  private async *iterateSapoProductPages(
    _resumeFromSapoId: number | null = null,
  ): AsyncGenerator<SapoImportProduct[]> {
    const host = resolveSapoStoreHost(this.config)!;
    const auth = resolveSapoApiAuth(this.config)!;
    const baseUrl = `https://${host}/admin/products.json`;

    // Sapo products: dùng page (id giảm dần). since_id không ổn định / dễ cắt sớm.
    for (let page = 1; page <= 500; page++) {
      let batch: SapoImportProduct[] = [];
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const { data } = await axios.get<{ products?: SapoImportProduct[] }>(baseUrl, {
            ...sapoAxiosConfig(auth),
            params: { limit: 250, page },
            timeout: 60_000,
          });
          batch = data.products ?? [];
          break;
        } catch (e) {
          if (attempt >= 5) throw e;
          const wait = attempt * 2000;
          this.logger.warn(`products fetch retry ${attempt} in ${wait}ms`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }

      if (!batch.length) break;
      this.logger.log(
        `Sapo products fetched page=${page} size=${batch.length} first=${batch[0]?.id} last=${batch[batch.length - 1]?.id}`,
      );
      yield batch;
      if (batch.length < 250) break;
      await new Promise((r) => setTimeout(r, 120));
    }
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
    const bySapo = await this.prisma.productVariant.findUnique({
      where: { sapoId: BigInt(sapoVariantId) },
    });
    if (bySapo) return bySapo.sku;

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
