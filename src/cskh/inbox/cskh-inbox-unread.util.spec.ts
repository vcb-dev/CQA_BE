import {
  isStaffLastMessage,
  customerWaitingFromMessages,
  lastMessagePreviewMismatch,
} from './cskh-inbox-unread.util';

describe('cskh-inbox-unread.util', () => {
  describe('isStaffLastMessage', () => {
    it('staff outbound = shop rep cuối', () => {
      expect(isStaffLastMessage({ senderType: 'staff', direction: 'outbound' })).toBe(true);
      expect(isStaffLastMessage({ senderType: 'customer', direction: 'outbound' })).toBe(true);
      expect(isStaffLastMessage({ senderType: 'customer', direction: 'inbound' })).toBe(false);
    });
  });

  describe('customerWaitingFromMessages', () => {
    it('shop rep cuối → không chờ xử lý', () => {
      expect(
        customerWaitingFromMessages(
          [{ senderType: 'customer', direction: 'inbound', text: 'hi' }],
          'shop reply',
        ),
      ).toBe(true);
      expect(
        customerWaitingFromMessages(
          [
            { senderType: 'customer', direction: 'inbound', text: 'hi' },
            { senderType: 'staff', direction: 'outbound', text: 'shop reply' },
          ],
          'shop reply',
        ),
      ).toBe(false);
    });

    it('chưa có tin DB nhưng có lastMessage → vẫn chờ', () => {
      expect(customerWaitingFromMessages([], 'preview từ Graph')).toBe(true);
      expect(customerWaitingFromMessages([], null)).toBe(false);
    });
  });

  describe('lastMessagePreviewMismatch', () => {
    it('phát hiện list vs DB lệch nhau', () => {
      expect(
        lastMessagePreviewMismatch('Em chào anh ạ', [
          { text: 'Mình cần tư vấn' },
        ]),
      ).toBe(true);
      expect(
        lastMessagePreviewMismatch('Em chào anh ạ', [{ text: 'Em chào anh ạ' }]),
      ).toBe(false);
      expect(lastMessagePreviewMismatch(null, [])).toBe(false);
      expect(lastMessagePreviewMismatch('hello', [])).toBe(true);
    });
  });
});
