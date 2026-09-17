import {
  cskhGraphConversationsOwnerId,
  cskhGraphMessagingOwnerId,
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
