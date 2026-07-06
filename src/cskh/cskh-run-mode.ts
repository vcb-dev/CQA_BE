export type CskhRunMode = 'api' | 'worker' | 'all';

/** api = HTTP only | worker = Redis queues only | all = dev (cả hai) */
export function getCskhRunMode(): CskhRunMode {
  const raw = (process.env.CSKH_RUN_MODE || 'api').trim().toLowerCase();
  if (raw === 'worker' || raw === 'all') return raw;
  return 'api';
}

export function isCskhApiProcess(): boolean {
  const mode = getCskhRunMode();
  return mode === 'api' || mode === 'all';
}

export function isCskhWorkerProcess(): boolean {
  const mode = getCskhRunMode();
  return mode === 'worker' || mode === 'all';
}

/** Audit chạy trên worker — không nhường inbox hot (tín hiệu dành cho API sync). */
export function shouldAuditYieldToInbox(): boolean {
  if (isCskhWorkerProcess() && getCskhRunMode() === 'worker') return false;
  return true;
}
