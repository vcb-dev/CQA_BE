import { commentMediaFromGraph } from '../../src/cskh/facebook/facebook-message.util';
import {
  CskhFacebookCommentsService,
  parsePageFeedComment,
} from '../../src/cskh/comment/cskh-facebook-comments.service';

describe('parsePageFeedComment', () => {
  it('returns null for likes and reactions', () => {
    const actualResult = parsePageFeedComment({
      item: 'like',
      verb: 'add',
      comment_id: 'c1',
      post_id: 'p1',
    });
    expect(actualResult).toBeNull();
  });

  it('parses a top-level comment add', () => {
    const actualResult = parsePageFeedComment({
      item: 'comment',
      verb: 'add',
      comment_id: 'c1',
      post_id: '123_456',
      parent_id: '123_456',
      message: 'Hello',
      created_time: 1_700_000_000,
      from: { id: 'u1', name: 'An' },
    });
    expect(actualResult).toEqual(
      expect.objectContaining({
        commentId: 'c1',
        postId: '123_456',
        parentId: null,
        text: 'Hello',
        fromId: 'u1',
        fromName: 'An',
      }),
    );
  });

  it('keeps parentId when reply is under another comment', () => {
    const actualResult = parsePageFeedComment({
      item: 'comment',
      verb: 'add',
      comment_id: 'c2',
      post_id: 'p1',
      parent_id: 'c1',
      from: { id: 'u2' },
    });
    expect(actualResult?.parentId).toBe('c1');
  });
});

describe('commentMediaFromGraph', () => {
  it('maps photo attachment when message is empty', () => {
    const actualResult = commentMediaFromGraph({
      message: '',
      attachment: {
        type: 'photo',
        media: { image: { src: 'https://scontent.xx.fbcdn.net/p.jpg' } },
      },
    });
    expect(actualResult).toEqual({
      text: '[Ảnh]',
      messageType: 'image',
      attachmentUrl: 'https://scontent.xx.fbcdn.net/p.jpg',
    });
  });

  it('prefers video source over thumbnail image', () => {
    const actualResult = commentMediaFromGraph({
      attachment: {
        type: 'video_inline',
        media: {
          image: { src: 'https://scontent.xx.fbcdn.net/thumb.jpg' },
          source: 'https://scontent.xx.fbcdn.net/clip.mp4',
        },
      },
    });
    expect(actualResult).toEqual({
      text: '[Video]',
      messageType: 'video',
      attachmentUrl: 'https://scontent.xx.fbcdn.net/clip.mp4',
    });
  });

  it('falls back to thumbnail when Graph only returns facebook.com/videos url', () => {
    const actualResult = commentMediaFromGraph({
      attachment: {
        type: 'video_inline',
        url: 'https://www.facebook.com/1105221848656682/videos/1272836194970982',
        media: { image: { src: 'https://scontent.xx.fbcdn.net/thumb.jpg' } },
      },
    });
    expect(actualResult).toEqual({
      text: '[Video]',
      messageType: 'image',
      attachmentUrl: 'https://scontent.xx.fbcdn.net/thumb.jpg',
    });
  });

  it('keeps caption and still stores video url', () => {
    const actualResult = commentMediaFromGraph({
      message: 'xem clip',
      attachment: { type: 'video_inline', media: { source: 'https://scontent.xx.fbcdn.net/v.mp4' } },
    });
    expect(actualResult.messageType).toBe('video');
    expect(actualResult.text).toBe('xem clip');
    expect(actualResult.attachmentUrl).toBe('https://scontent.xx.fbcdn.net/v.mp4');
  });
});

describe('CskhFacebookCommentsService.processWebhookPayload', () => {
  it('ignores non-page payloads without writing', async () => {
    const prisma = {
      facebookCskhConfig: { findUnique: jest.fn() },
    };
    const service = new CskhFacebookCommentsService(
      prisma as never,
      {} as never,
      { publish: jest.fn() } as never,
    );

    await service.processWebhookPayload({
      object: 'instagram',
      entry: [
        { id: '1', changes: [{ field: 'feed', value: { item: 'comment' } }] },
      ],
    });

    expect(prisma.facebookCskhConfig.findUnique).not.toHaveBeenCalled();
  });
});
