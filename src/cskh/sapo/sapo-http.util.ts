import axios, { type AxiosRequestConfig } from 'axios';
import type { ConfigService } from '@nestjs/config';
import {
  isSapoApiReady,
  resolveSapoApiAuth,
  resolveSapoStoreHost,
  sapoAxiosConfig,
} from './sapo-api.util';

export type SapoPageParams = Record<string, string | number | boolean | undefined>;

export function assertSapoReady(config: ConfigService): {
  host: string;
  axiosCfg: Pick<AxiosRequestConfig, 'headers' | 'auth'>;
} {
  if (!isSapoApiReady(config)) {
    throw new Error('Chưa cấu hình Sapo (SAPO_STORE + API key/secret hoặc access token)');
  }
  const host = resolveSapoStoreHost(config)!;
  const auth = resolveSapoApiAuth(config)!;
  return { host, axiosCfg: sapoAxiosConfig(auth) };
}

/** Paginate Sapo Admin REST list endpoints (limit max 250). */
export async function fetchSapoPages<T>(input: {
  config: ConfigService;
  path: string; // e.g. /admin/orders.json
  rootKey: string; // e.g. orders
  params?: SapoPageParams;
  maxPages?: number;
  delayMs?: number;
  onPage?: (info: { page: number; batchSize: number; total: number }) => void;
}): Promise<T[]> {
  const { host, axiosCfg } = assertSapoReady(input.config);
  const maxPages = input.maxPages ?? 500;
  const delayMs = input.delayMs ?? 200;
  const all: T[] = [];
  const url = `https://${host}${input.path}`;

  for (let page = 1; page <= maxPages; page++) {
    const { data } = await axios.get<Record<string, T[]>>(url, {
      ...axiosCfg,
      params: { limit: 250, page, ...(input.params ?? {}) },
      timeout: 90_000,
    });
    const batch = data[input.rootKey] ?? [];
    if (!Array.isArray(batch) || !batch.length) break;
    all.push(...batch);
    input.onPage?.({ page, batchSize: batch.length, total: all.length });
    if (batch.length < 250) break;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  return all;
}

export function parseSapoTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

export function parseSapoDate(raw: unknown): Date | null {
  if (raw == null || raw === '') return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toDecimalString(raw: unknown, fallback = '0'): string {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return String(n);
}
