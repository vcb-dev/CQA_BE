const { Client } = require('pg');

const SRC =
  'postgresql://postgres.vxjwgyvileqmllgeztbu:LuongVD1120@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres';
const DST =
  'postgresql://postgres.hvhornnujanjingzwjgf:trunghieu2003Hh%40@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres';

async function counts(url, label) {
  const c = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30_000,
  });
  await c.connect();
  const { rows } = await c.query(`
    SELECT c.relname AS table,
           GREATEST(c.reltuples::bigint, 0) AS estimate,
           (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint AS exact
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY 1
  `);
  // simpler exact counts
  const tables = await c.query(`
    SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1
  `);
  const out = [];
  for (const t of tables.rows) {
    const r = await c.query(`SELECT count(*)::int AS n FROM public."${t.tablename}"`);
    out.push({ table: t.tablename, n: r.rows[0].n });
  }
  out.sort((a, b) => b.n - a.n);
  console.log(`\n=== ${label} (${out.filter((x) => x.n > 0).length} non-empty / ${out.length} tables) ===`);
  for (const x of out.filter((x) => x.n > 0)) console.log(`${String(x.n).padStart(8)}  ${x.table}`);
  await c.end();
  return out;
}

(async () => {
  const src = await counts(SRC, 'SOURCE warehouse');
  const dst = await counts(DST, 'DEST shared');
  const srcMap = Object.fromEntries(src.map((x) => [x.table, x.n]));
  const dstMap = Object.fromEntries(dst.map((x) => [x.table, x.n]));
  console.log('\n=== DIFF (src>0 and dest) ===');
  for (const t of Object.keys(srcMap).sort()) {
    if (srcMap[t] > 0) {
      console.log(
        `${t}: src=${srcMap[t]} dest=${dstMap[t] ?? 'MISSING'}`,
      );
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
