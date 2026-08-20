import type { OmsProductListItem } from '../../../src/cskh/oms/oms-api.types';
import {
  extractSearchQueries,
  rankWarehouseProducts,
} from '../../../src/cskh/oms/oms-product-match.util';

function product(id: string, name: string, sku?: string): OmsProductListItem {
  return {
    id,
    name,
    image_url: null,
    default_sku: sku ?? null,
    skus: sku ? [sku] : [],
    variant_count: 1,
    price_from: 1_350_000,
    is_published: true,
  };
}

const JUMP_TRANSCRIPT = `
Mình cần tư vấn sản phẩm !!
Xin giá sp
Dây chuyền đá nhảy Moissanite 6.5 ly, thiết kế bạc S925 mạ bạch kim sáng bóng.
Chiều dài 39+5cm điều chỉnh Viên chủ: đá moissanite (có giấy kiểm định rõ ràng) Giá mẫu: 1tr350k ạ
`;

const JUMP_WRONG = [
  product('1', '(CHẾ TÁC) Đôi bông tai bông Tai Kim Hoa S925 đính Moissanite - HK90847', 'B9019-C001'),
  product('2', '(CHẾ TÁC) Mặt dây chuyền chế tác S925 đính Moissanite - HK88335', 'M9015-00-S-WH'),
  product('3', 'Dây chuyền Xuân Diệp S925 đính đá mois', 'D0048-00-S-WH'),
  product('4', 'Dây chuyền ngân hoa S925 đính đá moiss', 'D0049-00-S-WH'),
  product('5', 'Nhẫn S925 đính Moissanite', 'N0001-00-S-WH'),
];

const JUMP_RIGHT = product('99', 'Dây chuyền đá nhảy Moissanite 6.5 ly', 'D0100-00-S-WH');

const KIM_HOA_TRANSCRIPT = 'Nhẫn Kim Hoa';

const KIM_HOA_WRONG = [
  product('1', '(CHẾ TÁC) Đôi bông tai bông Tai Kim Hoa S925 đính Moissanite - HK90847', 'B9019-C001'),
  product('2', '(CHẾ TÁC) Nhẫn nữ chế tác S925 đính Moissanite viên chủ 10 li - HK88579', 'N9081-07-S-WH'),
  product('3', '(CHẾ TÁC) Nhẫn bạc chế tác S925 đính 5 viên đá Moissanite - HK91748', 'N9082-06-S-WH'),
  product('4', '(CHẾ TÁC) Bông tai chế tác S925 đính moissanite - HK86378', 'B9021-00-S-WH'),
  product('5', '(CHẾ TÁC) Nhẫn nam chế tác S925 đính Moissanite - HK87650', 'N620079'),
];

const KIM_HOA_RIGHT = [
  product('10', '(CHẾ TÁC) Nhẫn kim hoa S925 - HK88236', 'N-KH-01'),
  product('11', '(CHẾ TÁC) Nhẫn kim hoa trơn S925 đính đá Moissanite - HK87398', 'N-KH-02'),
];

describe('rankWarehouseProducts', () => {
  it('không chọn bông tai / Xuân Diệp / ngân hoa khi hội thoại nói đá nhảy 6.5 ly', () => {
    const ranked = rankWarehouseProducts([...JUMP_WRONG, JUMP_RIGHT], JUMP_TRANSCRIPT, [], 5);
    expect(ranked.map((r) => r.product.id)).toEqual(['99']);
  });

  it('không tự chọn gì nếu catalog không có cụm đặc trưng', () => {
    const ranked = rankWarehouseProducts(JUMP_WRONG, JUMP_TRANSCRIPT, [], 5);
    expect(ranked).toEqual([]);
  });

  it('trích query đá nhảy và 6.5 ly để search kho', () => {
    const qs = extractSearchQueries(JUMP_TRANSCRIPT);
    expect(qs.some((q) => /đá nhảy/i.test(q) || /da nhay/i.test(q))).toBe(true);
    expect(qs.some((q) => q.includes('6.5'))).toBe(true);
  });

  it('chọn nhẫn kim hoa, loại bông tai kim hoa và nhẫn khác', () => {
    const ranked = rankWarehouseProducts(
      [...KIM_HOA_WRONG, ...KIM_HOA_RIGHT],
      KIM_HOA_TRANSCRIPT,
      [],
      5,
    );
    expect(ranked.map((r) => r.product.id).sort()).toEqual(['10', '11']);
  });

  it('không tin tên SP do AI bịa trong mentions', () => {
    const ranked = rankWarehouseProducts(
      [...KIM_HOA_WRONG, ...KIM_HOA_RIGHT],
      KIM_HOA_TRANSCRIPT,
      KIM_HOA_WRONG.map((p) => p.name),
      5,
    );
    expect(ranked.map((r) => r.product.id).sort()).toEqual(['10', '11']);
  });
});
