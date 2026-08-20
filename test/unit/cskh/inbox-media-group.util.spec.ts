import {
  groupInboxMediaRows,
  parseInboxPhotoPreviewCount,
} from '../../../src/cskh/facebook/facebook-message.util';

function img(partial: {
  id?: string;
  text?: string;
  url?: string | null;
  sender?: string;
  at?: string;
}) {
  const sentAt = partial.at ?? '2026-08-20T06:29:00.000Z';
  return {
    id: partial.id ?? '1',
    senderType: partial.sender ?? 'staff',
    messageType: 'image',
    text: partial.text ?? '',
    attachmentUrl: partial.url ?? null,
    attachmentUrls: undefined as string[] | undefined,
    groupedMediaCount: undefined as number | undefined,
    sentAt,
  };
}

describe('groupInboxMediaRows', () => {
  it('merges follow-up photo-only rows into a captioned first image', () => {
    const grouped = groupInboxMediaRows([
      img({
        id: 'a',
        text: 'Dây chuyền đá nhảy Moissanite 6.5 ly',
        url: 'https://cdn.example/1.jpg',
      }),
      img({ id: 'b', url: 'https://cdn.example/2.jpg' }),
      img({ id: 'c', url: 'https://cdn.example/3.jpg' }),
      img({ id: 'd', url: 'https://cdn.example/4.jpg' }),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].text).toBe('Dây chuyền đá nhảy Moissanite 6.5 ly');
    expect(grouped[0].attachmentUrls).toEqual([
      'https://cdn.example/1.jpg',
      'https://cdn.example/2.jpg',
      'https://cdn.example/3.jpg',
      'https://cdn.example/4.jpg',
    ]);
    expect(grouped[0].groupedMediaCount).toBe(4);
  });

  it('does not merge a later captioned photo from the same sender', () => {
    const grouped = groupInboxMediaRows([
      img({ id: 'a', text: 'Ảnh 1', url: 'https://cdn.example/1.jpg' }),
      img({
        id: 'b',
        text: 'Ảnh 2 khác tin',
        url: 'https://cdn.example/2.jpg',
        at: '2026-08-20T06:29:01.000Z',
      }),
    ]);
    expect(grouped).toHaveLength(2);
  });

  it('counts placeholder siblings without URL so FE can resolve Graph', () => {
    const grouped = groupInboxMediaRows([
      img({ id: 'a', text: 'Caption', url: 'https://cdn.example/1.jpg' }),
      img({ id: 'b', text: '[Ảnh]', url: null }),
      img({ id: 'c', url: null }),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].attachmentUrls).toBeUndefined();
    expect(grouped[0].groupedMediaCount).toBe(3);
  });
});

describe('parseInboxPhotoPreviewCount', () => {
  it('reads [N ảnh] from the inbox list preview', () => {
    expect(parseInboxPhotoPreviewCount('[4 ảnh]')).toBe(4);
    expect(parseInboxPhotoPreviewCount('Dây chuyền')).toBe(0);
  });
});
