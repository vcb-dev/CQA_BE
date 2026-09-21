import { graphAttachmentType } from './facebook-graph.service';

describe('graphAttachmentType', () => {
  it('maps image and video mime types', () => {
    expect(graphAttachmentType('image/png', 'messenger')).toBe('image');
    expect(graphAttachmentType('video/mp4', 'instagram')).toBe('video');
  });

  it('allows pdf file on messenger only', () => {
    expect(graphAttachmentType('application/pdf', 'messenger')).toBe('file');
  });

  it('rejects non-media file on instagram', () => {
    expect(() =>
      graphAttachmentType('application/pdf', 'instagram'),
    ).toThrow(/Instagram/);
  });
});
