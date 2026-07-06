import axios from 'axios';

export const SAPO_DEFAULT_SCOPES = 'read_products,read_inventory';

/** vienchibao → vienchibao.mysapo.net */
export function normalizeSapoStoreHost(store: string): string {
  const raw = store.trim();
  if (!raw) return '';
  if (raw.includes('mysapo.net')) {
    return raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }
  return `${raw.replace(/\.mysapo\.net$/i, '')}.mysapo.net`;
}

export function buildSapoAuthorizeUrl(input: {
  store: string;
  clientId: string;
  redirectUri: string;
  scopes?: string;
}): string {
  const host = normalizeSapoStoreHost(input.store);
  const params = new URLSearchParams({
    client_id: input.clientId.trim(),
    scope: (input.scopes ?? SAPO_DEFAULT_SCOPES).trim(),
    redirect_uri: input.redirectUri.trim(),
  });
  return `https://${host}/admin/oauth/authorize?${params.toString()}`;
}

export async function exchangeSapoAccessToken(input: {
  store: string;
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<string> {
  const host = normalizeSapoStoreHost(input.store);
  const { data } = await axios.post<{ access_token?: string }>(
    `https://${host}/admin/oauth/access_token`,
    {
      client_id: input.clientId.trim(),
      client_secret: input.clientSecret.trim(),
      code: input.code.trim(),
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30_000,
    },
  );

  const token = (data.access_token ?? '').trim();
  if (!token) {
    throw new Error('Sapo không trả access_token — code có thể đã hết hạn hoặc redirect_uri không khớp');
  }
  return token;
}
