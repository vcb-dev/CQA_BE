import type { SapoCatalogVariant } from './sapo-product.service';

export type MatchedInterestedProduct = {
  productId: number;
  variantId: number;
  name: string;
  variantTitle: string;
  price: number;
  priceLabel: string;
  compareAtPrice: number | null;
  sku: string | null;
  imageUrl: string | null;
  inStock: boolean;
  matchReason: string;
};

function normalizeVi(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalizeVi(s)
    .split(/[^a-z0-9à-ỹ]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

function formatVnd(price: number): string {
  if (!Number.isFinite(price)) return '—';
  return `${Math.round(price).toLocaleString('vi-VN')}đ`;
}

function scoreVariant(
  query: string,
  item: SapoCatalogVariant,
): { score: number; reason: string } {
  const q = normalizeVi(query);
  if (!q) return { score: 0, reason: '' };

  const productTitle = normalizeVi(item.productTitle);
  const variantTitle = normalizeVi(item.variantTitle);
  const tags = normalizeVi(item.tags);
  const full = `${productTitle} ${variantTitle} ${tags}`.trim();

  if (full.includes(q) || q.includes(productTitle)) {
    return { score: 0.95, reason: `Khớp "${query}" với ${item.productTitle}` };
  }

  const qTokens = tokens(query);
  if (!qTokens.length) return { score: 0, reason: '' };

  const haystack = tokens(`${item.productTitle} ${item.variantTitle} ${item.tags}`);
  const haySet = new Set(haystack);
  let overlap = 0;
  for (const t of qTokens) {
    if (haySet.has(t)) overlap++;
  }
  const score = overlap / qTokens.length;
  if (score >= 0.5) {
    return { score, reason: `Từ khóa "${query}" (${overlap}/${qTokens.length})` };
  }
  return { score, reason: '' };
}

export function matchInterestedProducts(
  catalog: SapoCatalogVariant[],
  mentions: string[],
  topics: string[],
  summary: string,
  limit = 6,
): MatchedInterestedProduct[] {
  const queries = [...mentions, ...topics]
    .map((s) => s.trim())
    .filter(Boolean);
  if (!queries.length && summary.trim()) {
    queries.push(summary.trim());
  }

  const seen = new Set<number>();
  const scored: Array<{ item: SapoCatalogVariant; score: number; reason: string }> = [];

  for (const item of catalog) {
    let best = 0;
    let reason = '';
    for (const q of queries) {
      const { score, reason: r } = scoreVariant(q, item);
      if (score > best) {
        best = score;
        reason = r;
      }
    }
    if (best >= 0.45) {
      scored.push({ item, score: best, reason });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const out: MatchedInterestedProduct[] = [];
  for (const { item, reason } of scored) {
    if (seen.has(item.variantId)) continue;
    seen.add(item.variantId);
    const price = parseFloat(item.price) || 0;
    const compareAt = item.compareAtPrice ? parseFloat(item.compareAtPrice) : null;
    const name =
      item.variantTitle && !/^default/i.test(item.variantTitle)
        ? `${item.productTitle} · ${item.variantTitle}`
        : item.productTitle;
    out.push({
      productId: item.productId,
      variantId: item.variantId,
      name,
      variantTitle: item.variantTitle,
      price,
      priceLabel: formatVnd(price),
      compareAtPrice: compareAt,
      sku: item.sku,
      imageUrl: item.imageUrl,
      inStock: item.inventoryQuantity == null ? true : item.inventoryQuantity > 0,
      matchReason: reason,
    });
    if (out.length >= limit) break;
  }

  return out;
}
