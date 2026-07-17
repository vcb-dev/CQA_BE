/** Meta trả page_id dạng string hoặc number — chuẩn hóa để so khớp. */
export function normalizeMetaPageId(value: unknown): string | null {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  return /^\d+$/.test(s) ? s : null;
}

/** Lấy page_id từ creative (lead / engagement ads). */
export function extractPageIdFromCreative(
  creative: Record<string, unknown> | undefined,
): string | null {
  if (!creative) return null;
  const spec = creative.object_story_spec as Record<string, unknown> | undefined;
  if (!spec) return null;
  const direct = normalizeMetaPageId(spec.page_id);
  if (direct) return direct;
  for (const key of ['link_data', 'video_data', 'photo_data', 'template_data']) {
    const block = spec[key] as Record<string, unknown> | undefined;
    const pid = normalizeMetaPageId(block?.page_id);
    if (pid) return pid;
  }
  return null;
}

/** Lấy page_id từ adset promoted_object (Click-to-Messenger). */
export function extractPageIdFromPromotedObject(
  obj: Record<string, unknown> | undefined,
): string | null {
  if (!obj) return null;
  const direct = normalizeMetaPageId(obj.page_id);
  if (direct) return direct;
  const po = obj.promoted_object as Record<string, unknown> | undefined;
  return normalizeMetaPageId(po?.page_id);
}

export function pageIdsMatch(left: unknown, right: string): boolean {
  const a = normalizeMetaPageId(left);
  const b = normalizeMetaPageId(right);
  return !!a && !!b && a === b;
}
