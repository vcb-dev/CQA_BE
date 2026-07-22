import {
  buildSapoAuthorizeUrl,
  normalizeSapoStoreHost,
  SAPO_DEFAULT_SCOPES,
} from '../../../src/cskh/sapo/sapo-oauth.util';
import {
  extractNameMarkers,
  normalizeUnit,
  parseSapoDate,
  parseSapoProductType,
  parseSapoTags,
  resolveProductSlug,
  resolveVariantSku,
  slugifyProductName,
  stripHtml,
  variantDisplayTitle,
} from '../../../src/cskh/sapo/sapo-product-import.util';

describe('sapo-oauth.util', () => {
  describe('normalizeSapoStoreHost', () => {
    it('thêm .mysapo.net cho store name ngắn', () => {
      expect(normalizeSapoStoreHost('vienchibao')).toBe('vienchibao.mysapo.net');
    });

    it('giữ host đầy đủ và bỏ protocol / trailing slash', () => {
      expect(normalizeSapoStoreHost('https://vienchibao.mysapo.net/')).toBe(
        'vienchibao.mysapo.net',
      );
    });

    it('trả chuỗi rỗng khi input trống', () => {
      expect(normalizeSapoStoreHost('   ')).toBe('');
    });
  });

  describe('buildSapoAuthorizeUrl', () => {
    it('ghép URL OAuth đúng store + query', () => {
      const url = buildSapoAuthorizeUrl({
        store: 'vienchibao',
        clientId: 'cid-1',
        redirectUri: 'https://crm.example.com/oauth/sapo/callback',
      });

      expect(url.startsWith('https://vienchibao.mysapo.net/admin/oauth/authorize?')).toBe(
        true,
      );
      const qs = new URL(url).searchParams;
      expect(qs.get('client_id')).toBe('cid-1');
      expect(qs.get('redirect_uri')).toBe(
        'https://crm.example.com/oauth/sapo/callback',
      );
      expect(qs.get('scope')).toBe(SAPO_DEFAULT_SCOPES);
    });
  });
});

describe('sapo-product-import.util', () => {
  describe('parseSapoTags', () => {
    it('tách tag theo dấu phẩy', () => {
      expect(parseSapoTags('vang, bac ,  kim cuong')).toEqual([
        'vang',
        'bac',
        'kim cuong',
      ]);
    });

    it('trả [] khi rỗng', () => {
      expect(parseSapoTags(undefined)).toEqual([]);
    });
  });

  describe('slug / sku', () => {
    it('slugify tiếng Việt', () => {
      expect(slugifyProductName('Nhẫn Bạc Nữ', 99)).toBe('nhan-bac-nu');
    });

    it('resolveProductSlug ưu tiên alias', () => {
      expect(resolveProductSlug('Nhan-Bac-Nu', 'Nhẫn Bạc', 1)).toBe('nhan-bac-nu');
    });

    it('resolveVariantSku fallback SP-{id}', () => {
      expect(resolveVariantSku(null, 98765)).toBe('SP-98765');
      expect(resolveVariantSku('  ABC-001  ', 1)).toBe('ABC-001');
    });
  });

  describe('product type / unit / markers', () => {
    it('parse LOẠI >> CHẤT LIỆU', () => {
      expect(parseSapoProductType('NHẪN >> Bạc')).toEqual({
        category: 'NHẪN',
        material: 'Bạc',
      });
    });

    it('normalizeUnit', () => {
      expect(normalizeUnit('chiếc')).toBe('Chiếc');
      expect(normalizeUnit('2.6g')).toBeNull();
    });

    it('stripHtml / variantDisplayTitle / parseSapoDate', () => {
      expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
      expect(variantDisplayTitle({ title: 'Size M' })).toBe('Size M');
      expect(parseSapoDate('2024-01-15T10:00:00Z')?.toISOString()).toBe(
        '2024-01-15T10:00:00.000Z',
      );
    });

    it('extractNameMarkers', () => {
      expect(extractNameMarkers('(CHẾ TÁC) (Dừng bán) Nhẫn bạc nữ')).toEqual({
        name: 'Nhẫn bạc nữ',
        craftType: 'Chế tác',
        isDiscontinued: true,
      });
    });
  });
});
