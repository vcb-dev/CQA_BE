/**
 * Nếu DB đã có schema (vd. users) nhưng thiếu lịch sử `_prisma_migrations`,
 * đánh dấu toàn bộ migration local là đã apply — KHÔNG chạy lại SQL cũ.
 *
 * Sau đó `prisma migrate deploy` chỉ apply migration MỚI.
 *
 * Usage: node scripts/ensure-migration-baseline.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.resolve(__dirname, '../prisma/migrations');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

loadEnv(path.resolve(__dirname, '../.env'));

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((d) => fs.existsSync(path.join(MIGRATIONS_DIR, d, 'migration.sql')))
    .sort();
}

function deriveDirectUrl(databaseUrl) {
  try {
    const x = new URL(databaseUrl);
    if (x.port === '6543') x.port = '5432';
    x.searchParams.delete('pgbouncer');
    x.searchParams.delete('connection_limit');
    return x.toString();
  } catch {
    return databaseUrl;
  }
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }
  if (!process.env.DIRECT_URL) {
    process.env.DIRECT_URL = deriveDirectUrl(process.env.DATABASE_URL);
  }

  const url = process.env.DIRECT_URL;
  const c = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30_000,
  });
  await c.connect();
  await c.query('SET default_transaction_read_only = off');
  await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');

  const users = await c.query(
    `SELECT to_regclass('public.users') AS t`,
  );
  const hasUsers = Boolean(users.rows[0]?.t);

  await c.query(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Xóa bản ghi migration fail (vd. init_foundation dở) để resolve lại được
  const failed = await c.query(
    `SELECT migration_name FROM "_prisma_migrations"
     WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`,
  );
  for (const row of failed.rows) {
    console.log(`Removing failed/incomplete record: ${row.migration_name}`);
    await c.query(
      `DELETE FROM "_prisma_migrations" WHERE migration_name = $1`,
      [row.migration_name],
    );
  }

  const applied = await c.query(
    `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
  );
  const appliedSet = new Set(applied.rows.map((r) => r.migration_name));
  const migrations = listMigrations();
  const missing = migrations.filter((m) => !appliedSet.has(m));

  if (missing.length === 0) {
    console.log('Migration history OK — không cần baseline.');
    await c.end();
    return;
  }

  if (!hasUsers) {
    console.log(
      `DB trống (chưa có users) — bỏ qua baseline, để migrate deploy tạo schema (${missing.length} pending).`,
    );
    await c.end();
    return;
  }

  console.log(
    `DB đã có schema + thiếu ${missing.length} migration trong lịch sử → mark applied (không chạy SQL).`,
  );
  await c.end();

  for (const name of missing) {
    console.log(`  resolve --applied ${name}`);
    execFileSync(
      'npx',
      ['prisma', 'migrate', 'resolve', '--applied', name],
      {
        stdio: 'inherit',
        env: process.env,
        cwd: path.resolve(__dirname, '..'),
      },
    );
  }

  console.log('✅ baseline xong — migrate deploy chỉ chạy migration mới.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
