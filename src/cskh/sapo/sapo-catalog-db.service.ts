import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { SapoCatalogVariant } from './sapo-product.service';

/** Đọc catalog từ bảng products (sau khi import từ Sapo). */
@Injectable()
export class SapoCatalogDbService implements OnModuleInit {
  private readonly logger = new Logger(SapoCatalogDbService.name);
  private cachedCount = 0;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.refreshCount();
    if (this.cachedCount > 0) {
      this.logger.log(`Product catalog: ${this.cachedCount} variants (từ bảng products)`);
    }
  }

  hasCatalog(): boolean {
    return this.cachedCount > 0;
  }

  async refreshCount(): Promise<number> {
    try {
      this.cachedCount = await this.prisma.productVariant.count({
        where: {
          enabled: true,
          product: { isPublished: true, isDiscontinued: false },
        },
      });
    } catch {
      this.cachedCount = 0;
    }
    return this.cachedCount;
  }

  /** Chuẩn hóa tiêu đề variant: bỏ "Default (Title)" vô nghĩa. */
  private cleanVariantTitle(title: string | null): string {
    const t = (title ?? '').trim();
    if (!t) return '';
    if (/^default(\s+title)?$/i.test(t)) return '';
    return t;
  }

  async getCatalog(): Promise<SapoCatalogVariant[]> {
    const rows = await this.prisma.productVariant.findMany({
      where: {
        enabled: true,
        product: { isPublished: true, isDiscontinued: false },
      },
      include: {
        product: true,
        inventoryLevels: { take: 1, orderBy: { updatedAt: 'desc' } },
      },
      orderBy: [{ product: { name: 'asc' } }, { sku: 'asc' }],
      take: 5000,
    });
    this.cachedCount = rows.length;

    return rows.map((r) => {
      const onHand = r.inventoryLevels[0]?.available ?? r.inventoryLevels[0]?.onHand ?? null;
      return {
        productId: Number(r.productId),
        variantId: Number(r.id),
        productTitle: r.product.name,
        variantTitle: this.cleanVariantTitle(r.title),
        price: String(r.price),
        compareAtPrice: r.compareAtPrice != null ? String(r.compareAtPrice) : null,
        sku: r.sku,
        tags: r.product.tags.join(', '),
        imageUrl: r.imageUrl ?? r.product.imageUrl,
        inventoryQuantity: onHand,
        category: r.product.category,
        material: r.product.material,
        unit: r.product.unit,
      };
    });
  }
}
