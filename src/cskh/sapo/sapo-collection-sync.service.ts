import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { fetchSapoPages } from './sapo-http.util';
import { isSapoApiReady } from './sapo-api.util';

type SapoCollection = {
  id?: number;
  title?: string | null;
  name?: string | null;
  handle?: string | null;
  alias?: string | null;
  body_html?: string | null;
  description?: string | null;
  image?: { src?: string | null } | null;
};

export type SapoCollectionSyncResult = {
  source: 'sapo_api';
  fetched: number;
  upserted: number;
};

@Injectable()
export class SapoCollectionSyncService {
  private readonly logger = new Logger(SapoCollectionSyncService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  isReady(): boolean {
    return isSapoApiReady(this.config);
  }

  /** GET /admin/custom_collections.json (+ smart) → categories */
  async syncFromSapo(): Promise<SapoCollectionSyncResult> {
    const custom = await fetchSapoPages<SapoCollection>({
      config: this.config,
      path: '/admin/custom_collections.json',
      rootKey: 'custom_collections',
    }).catch((e) => {
      this.logger.warn(`custom_collections: ${e instanceof Error ? e.message : e}`);
      return [] as SapoCollection[];
    });

    const smart = await fetchSapoPages<SapoCollection>({
      config: this.config,
      path: '/admin/smart_collections.json',
      rootKey: 'smart_collections',
    }).catch((e) => {
      this.logger.warn(`smart_collections: ${e instanceof Error ? e.message : e}`);
      return [] as SapoCollection[];
    });

    const rows = [...custom, ...smart];
    let upserted = 0;

    for (const raw of rows) {
      const sapoId = raw.id ?? 0;
      if (!sapoId) continue;
      const name = (raw.title ?? raw.name ?? '').trim() || `Sapo collection ${sapoId}`;
      const handle = (raw.handle ?? raw.alias ?? '').trim();
      const slug = (handle || `sapo-col-${sapoId}`).slice(0, 200);
      const description = (raw.body_html ?? raw.description ?? null)?.toString() || null;
      const imageUrl = raw.image?.src ?? null;

      const bySapo = await this.prisma.category.findUnique({
        where: { sapoId: BigInt(sapoId) },
      });

      if (bySapo) {
        await this.prisma.category.update({
          where: { id: bySapo.id },
          data: {
            name,
            description,
            imageUrl,
            salesChannels: ['sapo'],
          },
        });
      } else {
        const slugTaken = await this.prisma.category.findUnique({ where: { slug } });
        const finalSlug = slugTaken ? `sapo-col-${sapoId}` : slug;
        await this.prisma.category.create({
          data: {
            sapoId: BigInt(sapoId),
            name,
            slug: finalSlug,
            description,
            imageUrl,
            salesChannels: ['sapo'],
            conditionType: 'manual',
          },
        });
      }
      upserted++;
    }

    this.logger.log(`Sapo collections sync: fetched=${rows.length} upserted=${upserted}`);
    return { source: 'sapo_api', fetched: rows.length, upserted };
  }
}
