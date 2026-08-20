import type { OmsProductListItem } from './oms-api.types';

export function normalizeVi(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const VI_STOPWORDS = new Set([
  'va',
  'cua',
  'cho',
  'voi',
  'la',
  'co',
  'khong',
  'em',
  'anh',
  'chi',
  'da',
  'shop',
  'minh',
  'ban',
  'nay',
  'kia',
  'duoc',
  'nhe',
  'nhu',
  'thi',
  'de',
  'con',
  'gi',
  'nha',
  'ok',
  'oi',
  'xin',
  'chao',
  'mua',
  'dat',
  'hang',
  'ship',
  'giao',
  'sp',
  'san',
  'pham',
  'size',
  'mau',
  'lay',
  'gui',
  'chot',
  'don',
]);

export function extractSkus(text: string): string[] {
  const found = text.match(/[A-Za-z]{1,8}\d{0,6}[-_][A-Za-z0-9][-_A-Za-z0-9]{2,}/g) ?? [];
  const uniq = new Set(found.map((s) => s.trim().toUpperCase()));
  return [...uniq];
}

export function extractSizes(text: string): string[] {
  const sizes = new Set<string>();
  const re = /\b(?:size|sz|cỡ)\s*[:\-]?\s*([a-z0-9]{1,4})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    sizes.add(m[1].toUpperCase());
  }
  return [...sizes];
}

export function extractVnPhone(text: string): string | undefined {
  const m = text.match(/(?:\+?84|0)(?:\d[\s.]?){8,10}\d/);
  if (!m) return undefined;
  return m[0].replace(/[^\d+]/g, '');
}

function tokens(s: string): string[] {
  return normalizeVi(s)
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !VI_STOPWORDS.has(t));
}

export type RankedWarehouseProduct = {
  product: OmsProductListItem;
  score: number;
  reason: string;
};

export function rankWarehouseProducts(
  catalog: OmsProductListItem[],
  transcript: string,
  extraMentions: string[],
  limit = 5,
): RankedWarehouseProduct[] {
  const hay = normalizeVi([transcript, ...extraMentions].join('\n'));
  if (!hay) return [];
  const skuHits = new Set(extractSkus(transcript).map((s) => s.toLowerCase()));
  const ranked: RankedWarehouseProduct[] = [];

  for (const p of catalog) {
    const name = normalizeVi(p.name || '');
    const skus = [p.default_sku, ...(p.skus ?? [])].filter(Boolean).map((s) => s!.toLowerCase());
    let score = 0;
    let reason = '';

    const skuMatch = skus.find((s) => s && (hay.includes(s) || skuHits.has(s)));
    if (skuMatch) {
      score += 100;
      reason = `Khớp SKU ${skuMatch.toUpperCase()}`;
    }

    if (name.length >= 4 && hay.includes(name)) {
      score += 70;
      reason = reason || `Khớp tên «${p.name}»`;
    }

    const sig = tokens(p.name || '').filter((t) => t.length >= 3);
    if (sig.length) {
      const hit = sig.filter((t) => hay.includes(t)).length;
      if (hit >= Math.min(2, sig.length) || (sig.length === 1 && sig[0].length >= 5 && hit === 1)) {
        const tokenScore = 20 + hit * 12;
        if (tokenScore > score) {
          score = tokenScore;
          reason = `Hội thoại nhắc «${p.name}»`;
        } else if (!reason && hit > 0) {
          score += tokenScore / 2;
          reason = `Hội thoại nhắc «${p.name}»`;
        }
      }
    }

    for (const mention of extraMentions) {
      const n = normalizeVi(mention);
      if (n.length >= 3 && (name.includes(n) || n.includes(name))) {
        score += 25;
        reason = reason || `Từ phân tích hội thoại: ${mention}`;
      }
    }

    if (score >= 20) ranked.push({ product: p, score, reason });
  }

  ranked.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: RankedWarehouseProduct[] = [];
  for (const row of ranked) {
    if (seen.has(row.product.id)) continue;
    seen.add(row.product.id);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

export function pickVariantTitle(
  optionValues: string[],
  mentionedSizes: string[],
): { prefer: string | null } {
  if (!mentionedSizes.length) return { prefer: null };
  const opts = optionValues.map((v) => v.trim().toUpperCase());
  const hit = mentionedSizes.find((s) => opts.includes(s) || opts.some((o) => o.includes(s)));
  return { prefer: hit ?? null };
}
