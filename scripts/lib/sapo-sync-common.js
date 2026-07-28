const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');

/** Unbuffered log (macOS redirects buffer console.log). */
function log(...args) {
  const line =
    args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ') + '\n';
  try {
    fs.writeSync(1, line);
  } catch {
    process.stdout.write(line);
  }
}

function loadEnv() {
  const file = path.resolve(__dirname, '../.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function stripPgBouncer(url) {
  return url
    .replace(/[?&]pgbouncer=true/gi, '')
    .replace(/\?&/, '?')
    .replace(/\?$/, '');
}

function withConnectionLimit(url, limit = 1) {
  const clean = stripPgBouncer(url);
  if (/[?&]connection_limit=/.test(clean)) {
    return clean.replace(/connection_limit=\d+/i, `connection_limit=${limit}`);
  }
  return `${clean}${clean.includes('?') ? '&' : '?'}connection_limit=${limit}`;
}

/**
 * Prefer a writable session connection for bulk INSERT.
 * Use DIRECT_URL (pooler :5432 session mode). Do NOT rewrite to db.*.supabase.co —
 * many projects only expose the pooler host from local networks.
 */
function resolveWritableDatabaseUrl() {
  loadEnv();
  let url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Missing DIRECT_URL / DATABASE_URL');

  // Transaction pooler :6543 often comes back read-only for writes.
  url = url.replace(':6543/', ':5432/');
  url = stripPgBouncer(url);
  url = withConnectionLimit(url, 1);
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  return url;
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname} user=${u.username}`;
  } catch {
    return '(invalid-url)';
  }
}

async function createWritablePrisma() {
  const url = resolveWritableDatabaseUrl();
  const prisma = new PrismaClient({
    datasources: { db: { url } },
  });
  await ensureWritable(prisma);
  log({ db: redactUrl(url) });
  return prisma;
}

async function ensureWritable(prisma) {
  try {
    await prisma.$executeRawUnsafe('SET default_transaction_read_only = off');
  } catch {
    /* ignore */
  }
  try {
    await prisma.$executeRawUnsafe(
      'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
    );
  } catch {
    /* ignore */
  }
}

function hostOf(store) {
  const s = (store || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return s.includes('mysapo.net') ? s : `${s}.mysapo.net`;
}

function sapoAuth() {
  loadEnv();
  const username =
    process.env.SAPO_API_KEY || process.env.SAPO_PRIVATE_API_KEY;
  const password =
    process.env.SAPO_API_SECRET || process.env.SAPO_PRIVATE_API_SECRET;
  if (!username || !password) {
    throw new Error('Missing SAPO_API_KEY / SAPO_API_SECRET');
  }
  return { username, password };
}

function sapoHost() {
  loadEnv();
  const host = hostOf(process.env.SAPO_STORE);
  if (!host) throw new Error('Missing SAPO_STORE');
  return host;
}

function errInfo(e) {
  const msg = e?.message || String(e);
  const m =
    msg.match(/message: "([^"]+)"/) ||
    msg.match(/PostgresError[^]*?message: "([^"]+)"/);
  return {
    code: e?.code || null,
    pg: m?.[1] || null,
    msg: msg.replace(/\s+/g, ' ').slice(0, 220),
  };
}

/** Max page for Sapo list APIs: page * limit <= 30000 */
const SAPO_MAX_PAGE_WINDOW = 120; // 120 * 250 = 30000

function addMonths(ymd, months) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d || 1));
  return dt.toISOString().slice(0, 10);
}

function* monthWindows(fromYmd = '2018-01-01', toYmd = null) {
  const end = toYmd || new Date().toISOString().slice(0, 10);
  let start = fromYmd;
  while (start < end) {
    const next = addMonths(start, 1);
    yield {
      created_on_min: start,
      created_on_max: next < end ? next : end,
    };
    start = next;
  }
}

/**
 * Fetch Sapo orders for one status.
 * Sapo rejects page*limit > 30000, so walk backward with created_on_max cursors.
 */
async function fetchSapoOrderPages(input) {
  const { host, auth, status, onPage, delayMs = 60 } = input;

  let createdOnMax = null; // ISO string cursor (exclusive upper bound via max filter)
  let windows = 0;

  while (windows < 50) {
    windows++;
    let windowFetched = 0;
    let oldestCreatedOn = null;
    let hitEnd = false;

    for (let page = 1; page <= SAPO_MAX_PAGE_WINDOW; page++) {
      const params = {
        limit: 250,
        page,
        status,
        ...(createdOnMax ? { created_on_max: createdOnMax } : {}),
      };

      let batch;
      try {
        const { data } = await axios.get(`https://${host}/admin/orders.json`, {
          auth,
          params,
          timeout: 90_000,
        });
        batch = data.orders || [];
      } catch (e) {
        if (e.response?.status === 422) {
          hitEnd = true;
          break;
        }
        throw e;
      }

      if (!batch.length) {
        hitEnd = true;
        break;
      }

      windowFetched += batch.length;
      for (const o of batch) {
        const t = o.created_on || o.created_at;
        if (t && (!oldestCreatedOn || t < oldestCreatedOn)) oldestCreatedOn = t;
      }

      await onPage({
        batch,
        page,
        status,
        window: { created_on_max: createdOnMax, n: windows },
        mode: 'created_on_max',
      });

      if (batch.length < 250) {
        hitEnd = true;
        break;
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }

    if (hitEnd && windowFetched < SAPO_MAX_PAGE_WINDOW * 250) break;
    if (!oldestCreatedOn) break;
    // Next window: everything strictly older than oldest seen.
    // Subtract 1s so the boundary row is not the only thing returned forever.
    const nextMax = new Date(new Date(oldestCreatedOn).getTime() - 1000).toISOString();
    if (createdOnMax && nextMax >= createdOnMax) break;
    createdOnMax = nextMax;
    log(
      JSON.stringify({
        status,
        nextWindow: windows + 1,
        created_on_max: createdOnMax,
        windowFetched,
      }),
    );
  }
}

async function fetchSapoListPages(input) {
  const {
    host,
    auth,
    path,
    rootKey,
    params = {},
    onPage,
    delayMs = 50,
    /** 'min' = ascending lists (customers); 'max' = newest-first; null = single 30k window */
    dateCursor = null,
  } = input;

  let cursor = null;
  let windows = 0;

  while (windows < 50) {
    windows++;
    let windowFetched = 0;
    let edgeDate = null; // newest for min, oldest for max
    let hitEnd = false;

    for (let page = 1; page <= SAPO_MAX_PAGE_WINDOW; page++) {
      const dateParams = {};
      if (dateCursor === 'min' && cursor) dateParams.created_on_min = cursor;
      if (dateCursor === 'max' && cursor) dateParams.created_on_max = cursor;

      let batch;
      try {
        const { data } = await axios.get(`https://${host}${path}`, {
          auth,
          params: { limit: 250, page, ...params, ...dateParams },
          timeout: 90_000,
        });
        batch = data[rootKey] || [];
      } catch (e) {
        if (e.response?.status === 422) {
          hitEnd = true;
          break;
        }
        throw e;
      }

      if (!batch.length) {
        hitEnd = true;
        break;
      }

      windowFetched += batch.length;
      for (const item of batch) {
        const t = item.created_on || item.created_at || item.published_on;
        if (!t) continue;
        if (dateCursor === 'min') {
          if (!edgeDate || t > edgeDate) edgeDate = t;
        } else if (dateCursor === 'max') {
          if (!edgeDate || t < edgeDate) edgeDate = t;
        }
      }

      await onPage({
        batch,
        page,
        window: { cursor, n: windows, dateCursor },
      });

      if (batch.length < 250) {
        hitEnd = true;
        break;
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }

    if (!dateCursor) {
      if (!hitEnd && windowFetched >= SAPO_MAX_PAGE_WINDOW * 250) {
        log(
          JSON.stringify({
            warn: 'hit Sapo 30000 window — pass dateCursor min/max to continue',
            path,
          }),
        );
      }
      break;
    }

    if (hitEnd && windowFetched < SAPO_MAX_PAGE_WINDOW * 250) break;
    if (!edgeDate) break;

    const next =
      dateCursor === 'min'
        ? new Date(new Date(edgeDate).getTime() + 1000).toISOString()
        : new Date(new Date(edgeDate).getTime() - 1000).toISOString();

    if (
      cursor &&
      ((dateCursor === 'min' && next <= cursor) ||
        (dateCursor === 'max' && next >= cursor))
    ) {
      break;
    }

    cursor = next;
    log(
      JSON.stringify({
        path,
        nextWindow: windows + 1,
        dateCursor,
        cursor,
        windowFetched,
      }),
    );
  }
}

module.exports = {
  log,
  loadEnv,
  resolveWritableDatabaseUrl,
  createWritablePrisma,
  ensureWritable,
  hostOf,
  sapoAuth,
  sapoHost,
  errInfo,
  fetchSapoOrderPages,
  fetchSapoListPages,
  SAPO_MAX_PAGE_WINDOW,
  redactUrl,
};
