import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const GRAPH_VERSION = process.env.FB_GRAPH_VERSION?.trim() || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Messenger + Marketing API (đọc chi phí QC).
 * Meta App → App Review: pages_* + ads_read, rồi OAuth lại.
 */
export const FB_OAUTH_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
  'ads_read',
].join(',');

export function getFacebookAppId(): string {
  return process.env.FB_APP_ID?.trim() || '';
}

export function getFacebookAppSecret(): string {
  return process.env.FB_APP_SECRET?.trim() || '';
}

export function getFacebookOAuthRedirectUri(): string {
  const explicit = process.env.FB_OAUTH_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const base = (process.env.PUBLIC_BE_URL || process.env.BE_PUBLIC_URL || 'http://localhost:3003').replace(
    /\/$/,
    '',
  );
  return `${base}/cskh/oauth/callback`;
}

function oauthStateSecret(): string {
  return (
    process.env.FB_OAUTH_STATE_SECRET?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    'dev-oauth-state-secret'
  );
}

export function signOAuthState(payload: { returnUrl: string; tenantId?: string; nonce: string }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', oauthStateSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyOAuthState(state: string): { returnUrl: string; tenantId?: string; nonce: string } | null {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', oauthStateSecret()).update(body).digest('base64url');
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function buildFacebookOAuthUrl(returnUrl: string, tenantId?: string): string {
  const appId = getFacebookAppId();
  if (!appId) throw new Error('FB_APP_ID chưa cấu hình trên BE');
  const redirectUri = getFacebookOAuthRedirectUri();
  const state = signOAuthState({
    returnUrl: returnUrl || '',
    tenantId,
    nonce: randomBytes(16).toString('hex'),
  });
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    scope: FB_OAUTH_SCOPES,
    response_type: 'code',
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

export function getFacebookWebhookVerifyToken(): string {
  return process.env.FB_WEBHOOK_VERIFY_TOKEN?.trim() || 'cskh-webhook-verify';
}

export function verifyFacebookWebhookSignature(rawBody: Buffer, signatureHeader?: string): boolean {
  const secret = getFacebookAppSecret();
  if (!secret) {
    console.error('[Webhook Signature] Verification failed: FB_APP_SECRET is not configured or is empty.');
    return false;
  }
  if (!signatureHeader) {
    console.error('[Webhook Signature] Verification failed: Missing signatureHeader.');
    return false;
  }
  if (!signatureHeader.startsWith('sha256=')) {
    console.error(`[Webhook Signature] Verification failed: Header format is invalid (received: ${signatureHeader}). Expected starts with sha256=`);
    return false;
  }
  if (!rawBody) {
    console.error('[Webhook Signature] Verification failed: rawBody is empty/undefined.');
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const received = signatureHeader.slice('sha256='.length);
  try {
    const isMatch = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
    if (!isMatch) {
      const maskedSecret = secret.length > 6 ? `${secret.slice(0, 3)}...${secret.slice(-3)}` : '***';
      console.error(`[Webhook Signature] Verification failed: Signature mismatch. Received: ${received}, Expected: ${expected}. Using Secret: ${maskedSecret}, Body length: ${rawBody.length}`);
    } else {
      console.log(`[Webhook Signature] Verification successful. Body length: ${rawBody.length}`);
    }
    return isMatch;
  } catch (err) {
    console.error('[Webhook Signature] Verification errored during comparison:', err);
    return false;
  }
}

export { GRAPH_BASE, GRAPH_VERSION };
