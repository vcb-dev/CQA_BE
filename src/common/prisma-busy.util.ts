/** Prisma/pg bận — không được để thành HTTP 500. */

let lastBusyAt = 0;

export function markPrismaBusy(): void {
  lastBusyAt = Date.now();
}

export function isPrismaRecentlyBusy(withinMs = 20_000): boolean {
  return lastBusyAt > 0 && Date.now() - lastBusyAt < withinMs;
}

function prismaCode(e: unknown): string {
  if (!e || typeof e !== 'object') return '';
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

export function isPrismaBusyError(e: unknown): boolean {
  const code = prismaCode(e);
  if (['P2024', 'P2028', 'P1001', 'P1002', 'P1008', 'P1017'].includes(code)) {
    markPrismaBusy();
    return true;
  }
  const msg = String((e as Error)?.message ?? e ?? '');
  const busy =
    /connection pool/i.test(msg) ||
    /Timed out fetching a new connection/i.test(msg) ||
    /statement timeout/i.test(msg) ||
    /\b57014\b/.test(msg) ||
    /EMAXCONNSESSION|max clients reached/i.test(msg) ||
    /Can't reach database server/i.test(msg) ||
    /P2024/.test(msg);
  if (busy) markPrismaBusy();
  return busy;
}

export function isPrismaClientFailure(e: unknown): boolean {
  if (isPrismaBusyError(e)) return true;
  const name = e?.constructor?.name ?? '';
  if (/PrismaClient(KnownRequest|UnknownRequest|Initialization|RustPanic)?Error/.test(name)) {
    return true;
  }
  return /Invalid `prisma\./i.test(String((e as Error)?.message ?? ''));
}
