import type { SapoCatalogVariant } from '../sapo/sapo-product.service';

export type ProductSearchEntry = {
  productId: number;
  title: string;
  normalizedTitle: string;
  significantTokens: string[];
};

const VI_STOPWORDS = new Set([
  'và',
  'của',
  'cho',
  'với',
  'là',
  'có',
  'không',
  'em',
  'anh',
  'chị',
  'ạ',
  'dạ',
  'shop',
  'mình',
  'bạn',
  'này',
  'kia',
  'được',
  'nhé',
  'như',
  'thì',
  'để',
  'còn',
  'gì',
  'nha',
  'ok',
  'ơi',
  'the',
  'xin',
  'chào',
  'nay',
  'hôm',
  'ngày',
  'mai',
  'đau',
  'bị',
  'bác',
  'gia',
  'giá',
  'minh',
  'ban',
  'bán',
  'mua',
  'đặt',
  'hàng',
  'ship',
  'giao',
  'vcb',
  'vien',
  'viên',
  'thuốc',
  'sp',
  'san',
  'sản',
  'phẩm',
  'default',
  'title',
]);

export function normalizeVi(s: string): string {
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

function significantTokens(title: string): string[] {
  return tokens(title).filter((t) => t.length >= 3 && !VI_STOPWORDS.has(t));
}

/** Một entry / productId — dùng tên SP chuẩn từ catalog. */
export function buildProductSearchIndex(catalog: SapoCatalogVariant[]): ProductSearchEntry[] {
  const byProduct = new Map<number, ProductSearchEntry>();

  for (const row of catalog) {
    const title = row.productTitle?.trim();
    if (!title) continue;

    const existing = byProduct.get(row.productId);
    if (existing && existing.title.length >= title.length) continue;

    const normalizedTitle = normalizeVi(title);
    if (normalizedTitle.length < 3) continue;

    byProduct.set(row.productId, {
      productId: row.productId,
      title,
      normalizedTitle,
      significantTokens: significantTokens(title),
    });
  }

  return [...byProduct.values()].sort((a, b) => b.normalizedTitle.length - a.normalizedTitle.length);
}

function isSubsumedTitle(shorter: string, longer: string): boolean {
  const a = normalizeVi(shorter);
  const b = normalizeVi(longer);
  return a !== b && b.includes(a);
}

function titleMatchesText(entry: ProductSearchEntry, normalizedText: string): boolean {
  if (!normalizedText || !entry.normalizedTitle) return false;

  if (entry.normalizedTitle.length >= 4 && normalizedText.includes(entry.normalizedTitle)) {
    return true;
  }

  const sig = entry.significantTokens;
  if (sig.length >= 2) {
    const matched = sig.filter((t) => normalizedText.includes(t));
    if (matched.length >= 2) return true;
  }

  if (sig.length === 1 && sig[0].length >= 5 && normalizedText.includes(sig[0])) {
    return true;
  }

  return false;
}

/** Tìm tên sản phẩm thật trong nội dung tin nhắn khách. */
export function matchProductsInInboundText(
  text: string,
  index: ProductSearchEntry[],
  limit = 6,
): string[] {
  const normalizedText = normalizeVi(text);
  if (!normalizedText || !index.length) return [];

  const matched: string[] = [];
  for (const entry of index) {
    if (!titleMatchesText(entry, normalizedText)) continue;
    if (matched.some((m) => isSubsumedTitle(m, entry.title) || isSubsumedTitle(entry.title, m))) {
      if (matched.some((m) => isSubsumedTitle(m, entry.title))) continue;
      const subsumedIdx = matched.findIndex((m) => isSubsumedTitle(entry.title, m));
      if (subsumedIdx >= 0) matched.splice(subsumedIdx, 1);
    }
    matched.push(entry.title);
    if (matched.length >= limit) break;
  }

  return matched;
}

export type ProductVideoAngle = {
  question: string;
  angle: string;
  hook: string;
  script: string[];
  cta: string;
};

const VIDEO_ANGLE_TEMPLATES: Array<(name: string, mentions: number) => ProductVideoAngle> = [
  (name, mentions) => ({
    question: `Khách hay hỏi về «${name}» — nên làm video gì?`,
    angle: `Review công dụng & đối tượng phù hợp của ${name}`,
    hook: `${mentions.toLocaleString('vi-VN')} hội thoại có nhắc «${name}» — đủ data để làm content.`,
    script: [
      `Mở đầu: "${name} dùng cho ai, có gì khác biệt?"`,
      'Giải thích công dụng chính trong 30–45 giây, dễ hiểu.',
      'Nêu 1–2 lưu ý khi dùng / chống chỉ định nếu có.',
      'Chốt CTA nhắn inbox để được tư vấn đúng liều.',
    ],
    cta: `Nhắn "tư vấn ${name}" để đặt hàng.`,
  }),
  (name, mentions) => ({
    question: `Video FAQ giá & cách mua «${name}»?`,
    angle: `Giải đáp giá, khuyến mãi và quy trình đặt ${name}`,
    hook: `Nhiều khách inbox hỏi giá ${name} (${mentions.toLocaleString('vi-VN')} lượt nhắc).`,
    script: [
      `Trả lời thẳng: giá ${name} hiện tại và combo/khuyến mãi.`,
      'Hướng dẫn 3 bước đặt hàng qua inbox/Facebook.',
      'Nhắc thời gian giao hàng và chính sách đổi trả.',
      'CTA comment hoặc nhắn tin ngay trên video.',
    ],
    cta: `Comment "MUA ${name.split(/\s+/).slice(0, 2).join(' ').toUpperCase()}" để nhận báo giá.`,
  }),
  (name) => ({
    question: `Hướng dẫn sử dụng «${name}» đúng cách?`,
    angle: `Demo liều dùng / cách dùng ${name} an toàn`,
    hook: `Video hướng dẫn giúp giảm hỏi đáp lặp lại về cách dùng ${name}.`,
    script: [
      `Chuẩn bị ${name} và dụng cụ cần thiết.`,
      'Demo từng bước sử dụng, nhấn mạnh liều/lần/ngày.',
      'Lỗi thường gặp khách hay mắc và cách tránh.',
      'Kêu gọi lưu video để xem lại khi cần.',
    ],
    cta: `Lưu video và nhắn shop nếu còn thắc mắc về ${name}.`,
  }),
  (name, mentions) => ({
    question: `Phản hồi thực tế khách dùng «${name}»?`,
    angle: `Tổng hợp feedback / case thực tế về ${name}`,
    hook: `${mentions.toLocaleString('vi-VN')} hội thoại nhắc ${name} — tận dụng insight khách thật.`,
    script: [
      'Chia sẻ 2–3 tình huống khách hay gặp (ẩn danh).',
      `Kết quả / trải nghiệm sau khi dùng ${name}.`,
      'Trả lời câu hỏi phổ biến còn lại.',
      'CTA inbox để được tư vấn cá nhân.',
    ],
    cta: `Nhắn inbox kể tình trạng của bạn để shop gợi ý ${name} phù hợp.`,
  }),
  (name) => ({
    question: `So sánh «${name}» với sản phẩm cùng nhóm?`,
    angle: `So sánh nhanh ${name} — giúp khách chọn đúng`,
    hook: `Video so sánh giúp khách tự quyết định, giảm tư vấn thủ công.`,
    script: [
      `Giới thiệu ${name} thuộc nhóm sản phẩm nào.`,
      'So sánh 2–3 tiêu chí: công dụng, đối tượng, mức giá.',
      `Kết luận rõ: ai nên chọn ${name}.`,
      'CTA inbox nếu chưa chắc chắn.',
    ],
    cta: `Nhắn "SO SÁNH" + tình trạng để shop tư vấn ${name}.`,
  }),
];

export function buildProductVideoTopic(
  productName: string,
  mentions: number,
  variantIndex: number,
): ProductVideoAngle {
  const fn = VIDEO_ANGLE_TEMPLATES[variantIndex % VIDEO_ANGLE_TEMPLATES.length];
  return fn(productName, mentions);
}
