/**
 * node-pg 8.16+ maps sslmode=require → verify-full (SELF_SIGNED_CERT_IN_CHAIN
 * on Supabase pooler). Restore libpq "encrypt, don't verify CA".
 * @see https://github.com/brianc/node-postgres/issues/3630
 */

function stripEnvQuotes(value) {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function appendQueryParam(url, kv) {
  return url + (url.includes('?') ? '&' : '?') + kv;
}

function ensurePgSslCompat(url) {
  if (!url) return url;
  if (!url.startsWith('postgresql://') && !url.startsWith('postgres://')) return url;

  let out = url;
  if (!/[?&]sslmode=/i.test(out)) {
    out = appendQueryParam(out, 'sslmode=require');
  }
  const mode = (out.match(/[?&]sslmode=([^&]*)/i)?.[1] || '').toLowerCase();
  if (
    (mode === 'require' || mode === 'prefer' || mode === 'verify-ca') &&
    !/[?&]uselibpqcompat=/i.test(out)
  ) {
    out = appendQueryParam(out, 'uselibpqcompat=true');
  }
  return out;
}

function applyToEnv() {
  if (process.env.DATABASE_URL) {
    process.env.DATABASE_URL = ensurePgSslCompat(stripEnvQuotes(process.env.DATABASE_URL));
  }
  if (process.env.DIRECT_URL) {
    process.env.DIRECT_URL = ensurePgSslCompat(stripEnvQuotes(process.env.DIRECT_URL));
  } else if (process.env.DATABASE_URL) {
    process.env.DIRECT_URL = process.env.DATABASE_URL;
  }
}

applyToEnv();

module.exports = { ensurePgSslCompat, applyToEnv, stripEnvQuotes };
