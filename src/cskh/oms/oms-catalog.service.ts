import { Injectable } from '@nestjs/common';
import { OmsApiService } from './oms-api.service';
import type { OmsCategoriesResponse, OmsCategory, OmsLocationsResponse } from './oms-api.types';

const CATALOG_TTL_MS = 10 * 60_000;

export interface OmsOption {
  id: string;
  name: string;
}

function flattenCategories(categories: OmsCategory[], out: OmsOption[] = []): OmsOption[] {
  for (const c of categories) {
    out.push({ id: c.id, name: c.name });
    if (c.children?.length) flattenCategories(c.children, out);
  }
  return out;
}

/** Danh mục sản phẩm / kho hàng từ OMS — chỉ dùng cho dropdown filter, cache trong memory. */
@Injectable()
export class OmsCatalogService {
  private categoriesCache: { at: number; data: OmsOption[] } | null = null;
  private locationsCache: { at: number; data: OmsOption[] } | null = null;

  constructor(private readonly omsApi: OmsApiService) {}

  async getCategories(): Promise<OmsOption[]> {
    if (this.categoriesCache && Date.now() - this.categoriesCache.at < CATALOG_TTL_MS) {
      return this.categoriesCache.data;
    }
    const res = await this.omsApi.get<OmsCategoriesResponse>('/categories');
    const options = flattenCategories(res.data ?? []).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    this.categoriesCache = { at: Date.now(), data: options };
    return options;
  }

  async getLocations(): Promise<OmsOption[]> {
    if (this.locationsCache && Date.now() - this.locationsCache.at < CATALOG_TTL_MS) {
      return this.locationsCache.data;
    }
    const res = await this.omsApi.get<OmsLocationsResponse>('/locations');
    const options = (res.data ?? [])
      .filter((l) => l.status === 'active')
      .map((l) => ({ id: l.id, name: l.name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    this.locationsCache = { at: Date.now(), data: options };
    return options;
  }
}
