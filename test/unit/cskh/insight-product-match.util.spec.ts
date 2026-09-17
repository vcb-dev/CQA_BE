import type { SapoCatalogVariant } from '../../../src/cskh/sapo/sapo-product.service';
import {
  VI_STOPWORDS,
  buildProductSearchIndex,
  matchProductsInInboundText,
  normalizeVi,
  viTokens,
  type ProductSearchEntry,
} from '../../../src/cskh/insight/insight-product-match.util';
import { extractKeywordsFromInboundText } from '../../../src/cskh/insight/inbox-insight.util';

function variant(productId: number, productTitle: string, variantId = productId * 10): SapoCatalogVariant {
  return {
    productId,
    variantId,
    productTitle,
    variantTitle: 'Mặc định',
    price: '100000',
    compareAtPrice: null,
    sku: null,
    tags: '',
    imageUrl: null,
    inventoryQuantity: null,
    category: null,
    material: null,
    unit: null,
  };
}

function entry(title: string, productId = 1): ProductSearchEntry {
  return buildProductSearchIndex([variant(productId, title)])[0];
}

describe('normalizeVi', () => {
  it('hạ chữ thường và bỏ dấu tiếng Việt', () => {
    expect(normalizeVi('Sữa Ong Chúa')).toBe('sua ong chua');
  });

  it('đưa "đ" về "d" — tên có dấu và tên gõ không dấu phải chuẩn hóa giống nhau', () => {
    expect(normalizeVi('Đông Trùng Hạ Thảo')).toBe('dong trung ha thao');
    expect(normalizeVi('Dong Trung Ha Thao')).toBe('dong trung ha thao');
  });

  it('gom khoảng trắng thừa', () => {
    expect(normalizeVi('  Canxi   D3  ')).toBe('canxi d3');
  });
});

describe('viTokens', () => {
  it('tách theo mọi ký tự không phải chữ/số', () => {
    expect(viTokens(normalizeVi('Hộp 20 viên/hộp - dùng 1 tháng'))).toEqual([
      'hop',
      '20',
      'vien',
      'hop',
      'dung',
      '1',
      'thang',
    ]);
  });

  it('trả mảng rỗng khi không còn ký tự nào', () => {
    expect(viTokens(normalizeVi('!!! ??? ---'))).toEqual([]);
  });
});

describe('VI_STOPWORDS', () => {
  it('lưu ở dạng đã chuẩn hóa để so khớp được với token', () => {
    expect(VI_STOPWORDS.has('dat')).toBe(true);
    expect(VI_STOPWORDS.has('gia')).toBe(true);
    expect(VI_STOPWORDS.has('đặt')).toBe(false);
  });
});

describe('buildProductSearchIndex', () => {
  it('mỗi productId một entry, giữ tên dài hơn', () => {
    const index = buildProductSearchIndex([
      variant(1, 'Canxi', 11),
      variant(1, 'Canxi D3 Ostelin', 12),
    ]);
    expect(index).toHaveLength(1);
    expect(index[0].title).toBe('Canxi D3 Ostelin');
  });

  it('bỏ tên rỗng hoặc quá ngắn', () => {
    const index = buildProductSearchIndex([
      variant(1, '   '),
      variant(2, 'A'),
      variant(3, 'Trà Hoa Cúc'),
    ]);
    expect(index.map((e) => e.title)).toEqual(['Trà Hoa Cúc']);
  });

  it('sắp xếp tên dài trước để tên chi tiết được khớp trước tên chung', () => {
    const index = buildProductSearchIndex([
      variant(1, 'Canxi'),
      variant(2, 'Canxi D3 Ostelin'),
    ]);
    expect(index.map((e) => e.title)).toEqual(['Canxi D3 Ostelin', 'Canxi']);
  });

  it('token đặc trưng bỏ stopword và token dưới 3 ký tự', () => {
    expect(entry('Viên uống Collagen cho da').significantTokens).toEqual(['uong', 'collagen']);
  });
});

describe('matchProductsInInboundText', () => {
  it('khớp khi khách nhắc nguyên tên sản phẩm', () => {
    const index = buildProductSearchIndex([variant(1, 'Trà Hoa Cúc')]);
    expect(matchProductsInInboundText('cho mình hỏi trà hoa cúc còn hàng không', index)).toEqual([
      'Trà Hoa Cúc',
    ]);
  });

  it('khớp tên có dấu khi khách gõ không dấu', () => {
    const index = buildProductSearchIndex([variant(1, 'Đông Trùng Hạ Thảo')]);
    expect(matchProductsInInboundText('dong trung ha thao gia bao nhieu', index)).toEqual([
      'Đông Trùng Hạ Thảo',
    ]);
  });

  it('khớp khi có từ hai token đặc trưng trọn vẹn', () => {
    const index = buildProductSearchIndex([variant(1, 'Sữa Ong Chúa Royal')]);
    expect(matchProductsInInboundText('shop còn sữa royal không ạ', index)).toEqual([
      'Sữa Ong Chúa Royal',
    ]);
  });

  it('KHÔNG khớp khi token chỉ nằm lọt trong từ khác', () => {
    const index = buildProductSearchIndex([variant(1, 'Trà Hoa Cúc')]);
    expect(matchProductsInInboundText('cho em hỏi trạng thái đơn, hoa quả gì đó', index)).toEqual([]);
  });

  it('KHÔNG khớp token đặc trưng duy nhất khi nó chỉ là một phần của từ dài hơn', () => {
    const index = buildProductSearchIndex([variant(1, 'Viên Collagen')]);
    expect(matchProductsInInboundText('em hỏi collagenplus bên kia', index)).toEqual([]);
    expect(matchProductsInInboundText('em hỏi collagen bên kia', index)).toEqual(['Viên Collagen']);
  });

  it('giữ tên chi tiết, bỏ tên chung bị bao hàm', () => {
    const index = buildProductSearchIndex([
      variant(1, 'Canxi'),
      variant(2, 'Canxi D3 Ostelin'),
    ]);
    expect(matchProductsInInboundText('tư vấn canxi d3 ostelin với ạ', index)).toEqual([
      'Canxi D3 Ostelin',
    ]);
  });

  it('bỏ tên chung đã khớp trước đó khi gặp tên chi tiết hơn', () => {
    const index = [entry('Canxi', 1), entry('Canxi D3 Ostelin', 2)];
    expect(matchProductsInInboundText('tư vấn canxi d3 ostelin với ạ', index)).toEqual([
      'Canxi D3 Ostelin',
    ]);
  });

  it('dừng đúng ở giới hạn số sản phẩm', () => {
    const index = buildProductSearchIndex([
      variant(1, 'Trà Hoa Cúc'),
      variant(2, 'Sữa Ong Chúa'),
      variant(3, 'Đông Trùng Hạ Thảo'),
    ]);
    const matched = matchProductsInInboundText(
      'mình hỏi trà hoa cúc, sữa ong chúa và đông trùng hạ thảo',
      index,
      2,
    );
    expect(matched).toHaveLength(2);
  });

  it('text rỗng hoặc index rỗng thì không khớp gì', () => {
    expect(matchProductsInInboundText('', [entry('Trà Hoa Cúc')])).toEqual([]);
    expect(matchProductsInInboundText('trà hoa cúc', [])).toEqual([]);
  });
});

describe('extractKeywordsFromInboundText', () => {
  it('bỏ link, stopword và token ngắn, sắp theo tần suất', () => {
    const keywords = extractKeywordsFromInboundText(
      'shop ơi https://vcb.vn/sp/123 collagen collagen có tốt không ạ, mình muốn hỏi collagen và canxi',
    );
    expect(keywords[0]).toBe('collagen');
    expect(keywords).toContain('canxi');
    expect(keywords).not.toContain('shop');
    expect(keywords).not.toContain('muon');
    expect(keywords.every((k) => k.length >= 4)).toBe(true);
  });

  it('chuẩn hóa "đ" nên cùng một từ gõ có dấu hay không dấu chỉ đếm một lần', () => {
    expect(extractKeywordsFromInboundText('đông trùng dong trung')).toEqual(['dong', 'trung']);
  });

  it('cắt đúng số lượng yêu cầu', () => {
    const text = 'collagen canxi vitamin omega magie kemzinc probiotic elevit ferrovit';
    expect(extractKeywordsFromInboundText(text, 3)).toHaveLength(3);
  });
});
