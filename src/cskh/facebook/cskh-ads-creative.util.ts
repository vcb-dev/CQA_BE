/** Lấy page_id từ creative (lead / engagement ads). */
export function extractPageIdFromCreative(
  creative: Record<string, unknown> | undefined,
): string | null {
  if (!creative) return null;
  const spec = creative.object_story_spec as Record<string, unknown> | undefined;
  if (!spec) return null;
  if (typeof spec.page_id === 'string') return spec.page_id;
  for (const key of ['link_data', 'video_data', 'photo_data', 'template_data']) {
    const block = spec[key] as Record<string, unknown> | undefined;
    if (typeof block?.page_id === 'string') return block.page_id;
  }
  return null;
}

/** Lấy page_id từ adset promoted_object (Click-to-Messenger). */
export function extractPageIdFromPromotedObject(
  obj: Record<string, unknown> | undefined,
): string | null {
  if (!obj) return null;
  if (typeof obj.page_id === 'string') return obj.page_id;
  const po = obj.promoted_object as Record<string, unknown> | undefined;
  if (typeof po?.page_id === 'string') return po.page_id;
  return null;
}
