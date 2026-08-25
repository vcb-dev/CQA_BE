/** Tháng lịch (Asia/Ho_Chi_Minh) cho list + count inbox. */

export type InboxMonthRange = { key: string; from: Date; to: Date };

const VN_OFFSET = '+07:00';

export function parseInboxMonthKey(raw?: string | null): InboxMonthRange | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec((raw ?? '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const from = new Date(`${m[1]}-${m[2]}-01T00:00:00${VN_OFFSET}`);
  const toMonth = month === 12 ? 1 : month + 1;
  const toYear = month === 12 ? year + 1 : year;
  const to = new Date(
    `${toYear}-${String(toMonth).padStart(2, '0')}-01T00:00:00${VN_OFFSET}`,
  );
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return { key: `${m[1]}-${m[2]}`, from, to };
}

export function currentInboxMonthKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  if (!year || !month) return parseInboxMonthKey(now.toISOString().slice(0, 7))?.key ?? '1970-01';
  return `${year}-${month}`;
}
