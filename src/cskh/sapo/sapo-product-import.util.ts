export type SapoImportProduct = {
  id?: number;
  name?: string;
  title?: string;
  alias?: string;
  vendor?: string;
  product_type?: string;
  tags?: string;
  status?: string;
  content?: string;
  summary?: string;
  meta_title?: string;
  meta_description?: string;
  vat_pit_category_code?: string;
  published_on?: string | null;
  created_on?: string | null;
  modified_on?: string | null;
  images?: Array<{ id?: number; src?: string; position?: number }>;
  image?: { src?: string };
  options?: Array<{ name?: string; position?: number }>;
  variants?: SapoImportVariant[];
};

export type SapoImportVariant = {
  id?: number;
  title?: string;
  option1?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price?: string | number;
  compare_at_price?: string | number | null;
  inventory_quantity?: number | null;
  weight?: number | null;
  weight_unit?: string | null;
  unit?: string | null;
  image_id?: number | null;
};

export function parseSapoTags(tags: string | undefined): string[] {
  if (!tags?.trim()) return [];
  return tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

export function slugifyProductName(name: string, fallbackId: number): string {
  const base = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  return base || `san-pham-${fallbackId}`;
}

export function resolveProductSlug(alias: string | undefined, name: string, sapoId: number): string {
  const fromAlias = (alias ?? '').trim().toLowerCase();
  if (fromAlias) return fromAlias.slice(0, 200);
  return slugifyProductName(name, sapoId);
}

export function resolveVariantSku(sku: string | null | undefined, sapoVariantId: number): string {
  const s = (sku ?? '').trim();
  if (s) return s.slice(0, 64);
  return `SP-${sapoVariantId}`;
}

export function variantDisplayTitle(variant: SapoImportVariant): string {
  return (variant.title ?? variant.option1 ?? 'Default').trim() || 'Default';
}

export function stripHtml(html: string | undefined): string | null {
  if (!html?.trim()) return null;
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50_000);
}

/**
 * Sapo lưu product_type dạng phân cấp "LOẠI >> CHẤT LIỆU" (VD: "NHẪN >> Bạc").
 * Tách thành category (loại SP) + material (chất liệu). Nếu chỉ 1 cấp → coi là category.
 */
export function parseSapoProductType(raw: string | undefined | null): {
  category: string | null;
  material: string | null;
} {
  const value = (raw ?? '').trim();
  if (!value) return { category: null, material: null };

  const parts = value
    .split('>>')
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 0) return { category: null, material: null };
  if (parts.length === 1) return { category: parts[0], material: null };
  // >2 cấp: cấp đầu là loại, phần còn lại gộp làm chất liệu
  return { category: parts[0], material: parts.slice(1).join(' >> ') };
}

const UNIT_CANONICAL: Record<string, string> = {
  chiec: 'Chiếc',
  cai: 'Cái',
  doi: 'Đôi',
  cap: 'Cặp',
  vien: 'Viên',
  day: 'Dây',
  set: 'Set',
  bo: 'Bộ',
  chuoi: 'Chuỗi',
  hop: 'Hộp',
};

function unitKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z]/g, '');
}

/**
 * Chuẩn hóa đơn vị tính: gộp hoa/thường (Chiếc/chiếc), map về dạng chuẩn.
 * Giá trị rác (chứa số như "2.6g") → null.
 */
export function normalizeUnit(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (/\d/.test(value)) return null;
  const key = unitKey(value);
  if (!key) return null;
  if (UNIT_CANONICAL[key]) return UNIT_CANONICAL[key];
  // Không nằm trong danh mục đã biết → giữ nguyên nhưng viết hoa chữ đầu
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function parseSapoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function markerKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const CRAFT_TYPE_MAP: Record<string, string> = {
  'che tac': 'Chế tác',
  'thiet ke': 'Thiết kế',
  mau: 'Mẫu',
};

export type NameMarkers = {
  name: string;
  craftType: string | null;
  isDiscontinued: boolean;
};

/**
 * Tách các tiền tố "(…)" ở đầu tên sản phẩm Sapo thành trường riêng:
 *  - Loại chế tác: (CHẾ TÁC) / (THIẾT KẾ) / (Mẫu) — gộp cả biến thể gõ sai/hoa thường.
 *  - Tình trạng ngừng: (Dừng bán) / (Dừng mã) / (Dừng nhập) → isDiscontinued.
 * Chỉ bóc tiền tố đã biết; các cụm khác (VD "(1 đôi)", "(TX155)") được giữ nguyên trong tên.
 */
export function extractNameMarkers(rawName: string): NameMarkers {
  // Bỏ khoảng trắng + dấu tổ hợp (combining marks) mồ côi ở đầu — có SP tên bắt đầu bằng ký tự rác.
  let name = (rawName ?? '').replace(/^[\s\p{M}]+/u, '').trim();
  let craftType: string | null = null;
  let isDiscontinued = false;

  const leading = /^[\s\p{M}]*\(([^)]*)\)\s*[-–:]?\s*/u;
  // Bóc lặp lại vì tên có thể có nhiều tiền tố liền nhau.
  for (let guard = 0; guard < 5; guard++) {
    const m = name.match(leading);
    if (!m) break;
    const key = markerKey(m[1]);

    if (CRAFT_TYPE_MAP[key]) {
      craftType = craftType ?? CRAFT_TYPE_MAP[key];
      name = name.slice(m[0].length).trim();
      continue;
    }
    if (key.startsWith('dung')) {
      isDiscontinued = true;
      name = name.slice(m[0].length).trim();
      continue;
    }
    break; // tiền tố không xác định → giữ nguyên phần còn lại
  }

  name = name.replace(/^[\s\p{M}]+/u, '').trim();
  return { name: name || rawName.trim(), craftType, isDiscontinued };
}
