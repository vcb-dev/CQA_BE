import {
  cskhGraphConversationsOwnerId,
  cskhGraphMessagingOwnerId,
  IG_WEBHOOK_SUBSCRIBED_FIELDS,
} from './facebook-oauth.util';

describe('cskhGraphConversationsOwnerId', () => {
  it('uses facebookPageId for instagram channels', () => {
    expect(
      cskhGraphConversationsOwnerId('17841400000000000', {
        platform: 'instagram',
        facebookPageId: '758889683984326',
      }),
    ).toBe('758889683984326');
  });

  it('keeps page id for messenger', () => {
    expect(
      cskhGraphConversationsOwnerId('758889683984326', { platform: 'messenger' }),
    ).toBe('758889683984326');
  });

  it('messaging owner matches conversations owner', () => {
    const meta = { platform: 'instagram', facebookPageId: '111' };
    expect(cskhGraphMessagingOwnerId('222', meta)).toBe(
      cskhGraphConversationsOwnerId('222', meta),
    );
  });
});

describe('IG_WEBHOOK_SUBSCRIBED_FIELDS', () => {
  it('subscribes comments with IG-only field names', () => {
    const fields = IG_WEBHOOK_SUBSCRIBED_FIELDS.split(',');
    expect(fields).toEqual(expect.arrayContaining(['comments', 'messages']));
    expect(fields).not.toContain('message_echoes');
    expect(fields).not.toContain('message_deliveries');
    expect(fields).not.toContain('message_reads');
    expect(fields).not.toContain('messaging_referrals');
  });
});
