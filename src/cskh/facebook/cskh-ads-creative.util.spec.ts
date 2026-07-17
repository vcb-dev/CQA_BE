import {
  extractPageIdFromCreative,
  extractPageIdFromPromotedObject,
} from './cskh-ads-creative.util';

const PAGE = '123456789012345';

describe('cskh-ads-creative.util', () => {
  describe('extractPageIdFromCreative', () => {
    it('object_story_spec.page_id', () => {
      expect(
        extractPageIdFromCreative({
          object_story_spec: { page_id: PAGE },
        }),
      ).toBe(PAGE);
    });

    it('link_data.page_id (Messenger ads cũ)', () => {
      expect(
        extractPageIdFromCreative({
          object_story_spec: { link_data: { page_id: PAGE } },
        }),
      ).toBe(PAGE);
    });

    it('video_data.page_id', () => {
      expect(
        extractPageIdFromCreative({
          object_story_spec: { video_data: { page_id: PAGE } },
        }),
      ).toBe(PAGE);
    });

    it('không có page_id → null', () => {
      expect(extractPageIdFromCreative({})).toBeNull();
      expect(extractPageIdFromCreative(undefined)).toBeNull();
    });
  });

  describe('extractPageIdFromPromotedObject', () => {
    it('promoted_object.page_id trên adset', () => {
      expect(
        extractPageIdFromPromotedObject({
          promoted_object: { page_id: PAGE },
        }),
      ).toBe(PAGE);
    });

    it('page_id trực tiếp', () => {
      expect(extractPageIdFromPromotedObject({ page_id: PAGE })).toBe(PAGE);
    });

    it('page_id dạng number (Meta Graph)', () => {
      expect(extractPageIdFromPromotedObject({ promoted_object: { page_id: Number(PAGE) } })).toBe(
        PAGE,
      );
    });
  });
});
