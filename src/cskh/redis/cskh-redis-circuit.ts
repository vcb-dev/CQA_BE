/** Shared circuit breaker when Upstash Redis hits monthly request quota. */
let blockedUntil = 0;
let lastWarnAt = 0;

export function isRedisQuotaError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  return /max requests limit exceeded|rate limit exceeded|ERR max requests/i.test(msg);
}

export function isRedisCircuitOpen(): boolean {
  return Date.now() < blockedUntil;
}

export function tripRedisCircuit(backoffMs = 30 * 60_000): void {
  blockedUntil = Date.now() + backoffMs;
}

export function onRedisQuotaTripped(logger?: { error: (msg: string) => void }): void {
  tripRedisCircuit();
  if (Date.now() - lastWarnAt < 60_000) return;
  lastWarnAt = Date.now();
  const mins = Math.round((blockedUntil - Date.now()) / 60_000);
  logger?.error(
    `Upstash Redis quota exceeded — pausing Redis ops ~${mins} phút, dùng fallback in-memory`,
  );
}

export function resetRedisCircuitForTests(): void {
  blockedUntil = 0;
  lastWarnAt = 0;
}
