import type { TranscriptLine } from '../audit/audit-analytics.util';

export type IntentMessage = { sender: string; text: string };

function parseMsgTime(raw?: string | Date | null): number {
  if (raw instanceof Date) return raw.getTime();
  if (!raw) return 0;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : 0;
}

export function transcriptToIntentMessages(transcript: unknown): IntentMessage[] {
  if (!Array.isArray(transcript)) return [];
  const out: IntentMessage[] = [];
  for (const line of transcript as TranscriptLine[]) {
    const text = (line.text ?? '').trim();
    if (!text) continue;
    out.push({
      sender: line.sender === 'Staff' ? 'Staff' : 'Customer',
      text,
    });
  }
  return out;
}

export function inboxToIntentMessages(
  rows: Array<{ senderType: string; text: string }>,
): IntentMessage[] {
  return rows
    .map((m) => ({
      sender: m.senderType === 'staff' ? 'Staff' : 'Customer',
      text: (m.text ?? '').trim(),
    }))
    .filter((m) => m.text.length > 0);
}

/** Gộp transcript audit + tin inbox realtime (sau ngày audit). */
export function mergeTranscriptWithInboxTail(
  transcript: unknown,
  inboxRows: Array<{ senderType: string; text: string; sentAt: Date }>,
): IntentMessage[] {
  const base = transcriptToIntentMessages(transcript);
  if (!base.length) return inboxToIntentMessages(inboxRows);

  let lastTranscriptTs = 0;
  const seen = new Set<string>();
  for (const line of transcript as TranscriptLine[]) {
    lastTranscriptTs = Math.max(lastTranscriptTs, parseMsgTime(line.timestamp));
    const role = line.sender === 'Staff' ? 'Staff' : 'Customer';
    const text = (line.text ?? '').trim().toLowerCase();
    if (text) seen.add(`${role}|${text}`);
  }

  const cutoff = lastTranscriptTs > 0 ? lastTranscriptTs - 120_000 : 0;
  const tail: IntentMessage[] = [];

  for (const row of inboxRows) {
    const t = parseMsgTime(row.sentAt);
    if (lastTranscriptTs > 0 && t < cutoff) continue;
    const sender = row.senderType === 'staff' ? 'Staff' : 'Customer';
    const text = (row.text ?? '').trim();
    if (!text) continue;
    const key = `${sender}|${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tail.push({ sender, text });
  }

  return [...base, ...tail];
}

/** Giới hạn độ dài gửi AI — giữ đầu + cuối hội thoại. (Đã bỏ giới hạn theo yêu cầu) */
export function capIntentMessages(messages: IntentMessage[], max = 100): IntentMessage[] {
  return messages;
}

export function intentMessagesSignature(messages: IntentMessage[]): string {
  if (!messages.length) return 'empty';
  const last = messages[messages.length - 1];
  return `${messages.length}:${last.sender}:${last.text.slice(0, 80)}`;
}
