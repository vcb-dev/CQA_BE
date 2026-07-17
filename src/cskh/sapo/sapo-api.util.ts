import type { ConfigService } from '@nestjs/config';
import type { AxiosRequestConfig } from 'axios';
import { normalizeSapoStoreHost } from './sapo-oauth.util';

export type SapoApiAuth =
  | { mode: 'token'; headers: Record<string, string> }
  | { mode: 'basic'; auth: { username: string; password: string } };

/** OAuth Partner App dùng X-Sapo-Access-Token; Ứng dụng riêng dùng Basic Auth (key + secret). */
export function resolveSapoStoreHost(config: ConfigService): string | null {
  const raw = (config.get<string>('SAPO_STORE') ?? '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return null;
  return normalizeSapoStoreHost(raw);
}

export function resolveSapoApiAuth(config: ConfigService): SapoApiAuth | null {
  const token = (config.get<string>('SAPO_ACCESS_TOKEN') ?? '').trim();
  if (token) {
    return {
      mode: 'token',
      headers: {
        'Content-Type': 'application/json',
        'X-Sapo-Access-Token': token,
      },
    };
  }

  const mode = (config.get<string>('SAPO_AUTH_MODE') ?? '').trim().toLowerCase();
  const key = (config.get<string>('SAPO_PRIVATE_API_KEY') ?? config.get<string>('SAPO_API_KEY') ?? '').trim();
  const secret = (config.get<string>('SAPO_PRIVATE_API_SECRET') ?? config.get<string>('SAPO_API_SECRET') ?? '').trim();

  // Private App: Basic Auth (key + secret). Bật explicit hoặc tự nhận khi không có OAuth token.
  const privateMode = mode === 'private' || (!mode && key && secret);
  if (privateMode && key && secret) {
    return {
      mode: 'basic',
      auth: { username: key, password: secret },
    };
  }

  return null;
}

export function isSapoApiReady(config: ConfigService): boolean {
  return Boolean(resolveSapoStoreHost(config) && resolveSapoApiAuth(config));
}

export function sapoAxiosConfig(auth: SapoApiAuth): Pick<AxiosRequestConfig, 'headers' | 'auth'> {
  if (auth.mode === 'token') {
    return { headers: auth.headers };
  }
  return {
    headers: { 'Content-Type': 'application/json' },
    auth: auth.auth,
  };
}
