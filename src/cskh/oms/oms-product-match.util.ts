import type { OmsProductListItem } from './oms-api.types';

export function normalizeVi(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Từ quá phổ biến trên catalog trang sức — không đủ để chọn SP. */
const GENERIC_TOKENS = new Set([
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
  'day',
  'chuyen',
  'mat',
  'bong',
  'tai',
  'nhan',
  'lac',
  'bac',
  'vang',
  's925',
  '925',
  'dinh',
  'mois',
  'moiss',
  'moissanite',
  'che',
  'tac',
  'ma',
  'bach',
  'gia',
  'ly',
  'cm',
  'thiet',
  'ke',
  'chieu',
  'dai',
  'vien',
  'chu',
  'giay',
  'kiem',
  'ro',
  'rang',
  'trang',
  'suc',
  'doi',
  'sang',
  'dieu',
  'chinh',
  'nu',
  'nam',
  'tron',
  'can',
  'tu',
  'van',
  'gia',
  'mau',
  'li',
]);

export type JewelCategory = 'nhan' | 'bong_tai' | 'day_chuyen' | 'mat' | 'lac';

export type ProductFocus = {
  category: JewelCategory | null;
  tokens: string[];
};

export function extractSkus(text: string): string[] {
  const found = [
    ...(text.match(/[A-Za-z]{1,8}\d{0,6}[-_][A-Za-z0-9][-_A-Za-z0-9]{2,}/g) ?? []),
    ...(text.match(/\bHK\d{4,}\b/gi) ?? []),
    ...(text.match(/\b[A-Z]\d{4,}[-][A-Z0-9][-A-Z0-9]+\b/g) ?? []),
  ];
  return [...new Set(found.map((s) => s.trim().toUpperCase()))];
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
  const n = normalizeVi(s);
  const parts = n.match(/[a-z]+|\d+(?:[.,]\d+)?/g) ?? [];
  return parts.map((t) => t.replace(',', '.')).filter((t) => t.length > 0);
}

function isSkuishToken(t: string): boolean {
  return /^hk\d+$/i.test(t) || /^\d{4,}$/.test(t);
}

function isDistinctiveToken(t: string): boolean {
  if (GENERIC_TOKENS.has(t) || isSkuishToken(t)) return false;
  if (/^\d+(?:\.\d+)?$/.test(t)) return t.includes('.') || t.length >= 2;
  return t.length >= 3;
}

/** Bỏ tên catalog do AI bịa (có HK / CHẾ TÁC). Giữ cụm ngắn như «Nhẫn Kim Hoa». */
export function usableMention(s: string): boolean {
  const t = s.trim();
  if (t.length < 4 || t.length > 48) return false;
  if (/HK\d{4,}/i.test(t)) return false;
  if (/chế tác|che tac/i.test(t)) return false;
  if (/đính\s+moissanite|dinh\s+moissanite/i.test(t)) return false;
  return true;
}

function consumeCategory(toks: string[], i: number): { category: JewelCategory; next: number } | null {
  const a = toks[i];
  const b = toks[i + 1];
  const c = toks[i + 2];
  if (a === 'bong' && b === 'tai') return { category: 'bong_tai', next: i + 2 };
  if (a === 'doi' && b === 'bong' && c === 'tai') return { category: 'bong_tai', next: i + 3 };
  if (a === 'mat' && b === 'day' && c === 'chuyen') return { category: 'mat', next: i + 3 };
  if (a === 'mat' && b === 'day') return { category: 'mat', next: i + 2 };
  if (a === 'day' && b === 'chuyen') return { category: 'day_chuyen', next: i + 2 };
  if (a === 'lac' && (b === 'tay' || b === 'chan')) return { category: 'lac', next: i + 2 };
  if (a === 'lac') return { category: 'lac', next: i + 1 };
  if (a === 'nhan') return { category: 'nhan', next: i + 1 };
  return null;
}

export function detectProductCategory(name: string): JewelCategory | null {
  const toks = tokens(name);
  for (let i = 0; i < toks.length; i += 1) {
    const hit = consumeCategory(toks, i);
    if (hit) return hit.category;
  }
  return null;
}

export function extractProductFocuses(text: string): ProductFocus[] {
  const focuses: ProductFocus[] = [];
  const lines = text.split(/[\n.!?]/).map((l) => l.trim()).filter(Boolean);
  const sources = lines.length ? lines : [text];

  for (const line of sources) {
    const toks = tokens(line);
    let i = 0;
    while (i < toks.length) {
      const cat = consumeCategory(toks, i);
      if (!cat) {
        i += 1;
        continue;
      }
      i = cat.next;
      const collected: string[] = [];
      while (i < toks.length && collected.length < 4) {
        const t = toks[i];
        const nested = consumeCategory(toks, i);
        if (nested && collected.length) break;
        if (t === 'bach' && toks[i + 1] === 'kim') {
          i += 2;
          continue;
        }
        if (GENERIC_TOKENS.has(t) || isSkuishToken(t)) {
          i += 1;
          continue;
        }
        if (isDistinctiveToken(t)) collected.push(t);
        i += 1;
      }
      if (collected.length) focuses.push({ category: cat.category, tokens: collected });
    }
  }

  const seen = new Set<string>();
  return focuses.filter((f) => {
    const key = `${f.category}:${f.tokens.join(' ')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function productHasFocus(name: string, focus: ProductFocus): boolean {
  const n = normalizeVi(name);
  const pt = new Set(tokens(name));
  const productCat = detectProductCategory(name);
  if (focus.category && productCat && productCat !== focus.category) return false;
  if (focus.category && !productCat) return false;
  return focus.tokens.every((t) => pt.has(t) || n.includes(t));
}

/** Cụm tìm trên warehouse GET /products?q= */
export function extractSearchQueries(transcript: string, extraMentions: string[] = []): string[] {
  const mentions = extraMentions.map((s) => s.trim()).filter(usableMention);
  const queries: string[] = [...mentions];
  const hay = normalizeVi([transcript, ...mentions].join('\n'));

  for (const focus of extractProductFocuses([transcript, ...mentions].join('\n'))) {
    const label = [focus.category === 'nhan' ? 'nhẫn' : focus.category === 'bong_tai' ? 'bông tai' : focus.category === 'day_chuyen' ? 'dây chuyền' : focus.category === 'mat' ? 'mặt dây' : 'lắc', ...focus.tokens].join(' ');
    if (label.length >= 4) queries.unshift(label);
  }

  const lines = transcript
    .split(/[\n.!?]/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 12 && l.length <= 90);
  const productLine = /day\s*chuyen|nhan\b|bong\s*tai|mat\s*day|lac\s*tay|mois|moissanite|s925/i;
  for (const line of lines) {
    if (productLine.test(normalizeVi(line))) {
      const cut = line.replace(/\s+/g, ' ');
      if (!queries.some((q) => q.includes(cut) || cut.includes(q))) queries.push(cut);
    }
  }

  if (hay.includes('da nhay') || hay.includes('nhay')) queries.unshift('đá nhảy');
  const sizeLy = transcript.match(/(\d+(?:[.,]\d+)?)\s*ly/i);
  if (sizeLy) queries.unshift(`${sizeLy[1].replace(',', '.')} ly`);
  if (hay.includes('kim hoa')) queries.unshift(hay.includes('nhan') ? 'nhẫn kim hoa' : 'kim hoa');

  return [...new Set(queries)].slice(0, 6);
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
  limit = 3,
): RankedWarehouseProduct[] {
  const mentions = extraMentions.filter(usableMention);
  const hayRaw = [transcript, ...mentions].join('\n');
  const hay = normalizeVi(hayRaw);
  if (!hay) return [];

  const hayTokens = new Set(tokens(hay));
  const skuHits = new Set(extractSkus(transcript).map((s) => s.toLowerCase()));
  const focuses = extractProductFocuses(hayRaw);
  const ranked: RankedWarehouseProduct[] = [];

  for (const p of catalog) {
    const name = normalizeVi(p.name || '');
    const skus = [p.default_sku, ...(p.skus ?? [])].filter(Boolean).map((s) => s!.toLowerCase());
    let score = 0;
    let reason = '';

    const skuMatch = skus.find((s) => s && (skuHits.has(s) || hayTokens.has(s)));
    if (skuMatch) {
      score += 100;
      reason = `Hội thoại nhắc SKU ${skuMatch.toUpperCase()}`;
    }

    const matchedFocus = focuses.find((f) => productHasFocus(p.name || '', f));
    if (matchedFocus) {
      const phrase = matchedFocus.tokens.join(' ');
      const focusScore = 70 + matchedFocus.tokens.length * 12;
      if (focusScore > score) {
        score = focusScore;
        reason = `Hội thoại nhắc «${phrase}»`;
      } else if (!reason) {
        reason = `Hội thoại nhắc «${phrase}»`;
      }
    }

    const transcriptHasExactName = name.length >= 16 && normalizeVi(transcript).includes(name);
    if (transcriptHasExactName && (!focuses.length || matchedFocus)) {
      score = Math.max(score, 95);
      reason = reason || `Hội thoại nhắc «${p.name}»`;
    }

    if (score < 55) continue;
    if (!skuMatch && focuses.length && !matchedFocus) continue;
    if (!skuMatch && !matchedFocus && !transcriptHasExactName) continue;

    ranked.push({ product: p, score, reason });
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
