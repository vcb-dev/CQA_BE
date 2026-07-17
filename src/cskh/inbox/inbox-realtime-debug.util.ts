import { Logger } from '@nestjs/common';

const LOG_PREFIX = '[CSKH Inbox RT]';
const logger = new Logger('CskhInboxRealtimeDbg');

/** Bật mặc định. Tắt: CSKH_INBOX_RT_DEBUG=false */
export function isInboxRtDebugEnabled(): boolean {
  return process.env.CSKH_INBOX_RT_DEBUG !== 'false';
}

export type InboxRtTrace = {
  id: number;
  step: string;
  startedAt: number;
  meta: Record<string, unknown>;
};

let traceSeq = 0;

function safeJson(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

export function inboxRtLog(message: string, meta?: Record<string, unknown>): void {
  if (!isInboxRtDebugEnabled()) return;
  if (meta) logger.log(`${LOG_PREFIX} ${message} ${safeJson(meta)}`);
  else logger.log(`${LOG_PREFIX} ${message}`);
}

export function inboxRtWarn(message: string, meta?: Record<string, unknown>): void {
  if (!isInboxRtDebugEnabled()) return;
  if (meta) logger.warn(`${LOG_PREFIX} ${message} ${safeJson(meta)}`);
  else logger.warn(`${LOG_PREFIX} ${message}`);
}

export function inboxRtTraceStart(
  step: string,
  meta: Record<string, unknown> = {},
): InboxRtTrace | null {
  if (!isInboxRtDebugEnabled()) return null;
  const trace: InboxRtTrace = {
    id: ++traceSeq,
    step,
    startedAt: Date.now(),
    meta,
  };
  inboxRtLog(`${step} START`, meta);
  return trace;
}

export function inboxRtTraceMark(
  trace: InboxRtTrace | null,
  mark: string,
  extra: Record<string, unknown> = {},
): void {
  if (!trace) return;
  const elapsedMs = Date.now() - trace.startedAt;
  inboxRtLog(`${trace.step} +${elapsedMs}ms ${mark}`, { ...trace.meta, ...extra });
}

export function inboxRtTraceDone(
  trace: InboxRtTrace | null,
  extra: Record<string, unknown> = {},
): void {
  if (!trace) return;
  const totalMs = Date.now() - trace.startedAt;
  inboxRtLog(`${trace.step} DONE ${totalMs}ms`, { ...trace.meta, ...extra, totalMs });
}
