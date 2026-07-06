export type InboxMessageDirectionHint = {
  senderType: string;
  direction: string;
  text?: string | null;
};

export function isStaffLastMessage(
  last: { senderType: string; direction: string } | undefined,
): boolean {
  if (!last) return false;
  return last.senderType === 'staff' || last.direction === 'outbound';
}

/** Khách đang chờ xử lý (tin cuối từ khách hoặc chưa có tin trong DB). */
export function customerWaitingFromMessages(
  messages: InboxMessageDirectionHint[],
  convLastMessage: string | null | undefined,
): boolean {
  const last = messages[messages.length - 1];
  if (last) return !isStaffLastMessage(last);
  return Boolean(convLastMessage?.trim());
}

export function lastMessagePreviewMismatch(
  convLastMessage: string | null | undefined,
  messages: Array<{ text?: string | null }>,
): boolean {
  const preview = convLastMessage?.trim();
  if (!preview) return false;
  if (!messages.length) return true;
  const lastText = messages[messages.length - 1]?.text?.trim() ?? '';
  return lastText !== preview;
}
