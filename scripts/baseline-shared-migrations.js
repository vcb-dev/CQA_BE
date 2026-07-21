/**
 * Baseline shared DB: đánh dấu toàn bộ migration đã apply
 * (schema đã sync bằng db push — không chạy lại SQL cũ).
 *
 * Chỉ chạy 1 lần sau khi db push / copy schema tay.
 *
 * Usage:
 *   npm run db:baseline:shared
 *   DST_DIRECT_URL=... node scripts/baseline-shared-migrations.js
 */
const fs = require('fs');
const path = require('path');
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

const url =
  process.env.DST_DIRECT_URL ||
  process.env.DIRECT_URL ||
  process.env.DST_DATABASE_URL ||
  process.env.DATABASE_URL;

if (!url) {
  console.error('Missing DATABASE_URL / DIRECT_URL');
  process.exit(1);
}

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((d) => fs.existsSync(path.join(MIGRATIONS_DIR, d, 'migration.sql')))
    .sort();
}

(async () => {
  const migrations = listMigrations();
  console.log(`Found ${migrations.length} migrations in prisma/migrations`);
  console.log(`DB: ${url.replace(/:[^:@/]+@/, ':***@')}`);

  const c = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30_000,
  });
  await c.connect();
  await c.query('SET default_transaction_read_only = off');
  await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');

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

  let inserted = 0;
  let skipped = 0;
  for (const name of migrations) {
    const exists = await c.query(
      `SELECT 1 FROM "_prisma_migrations" WHERE "migration_name" = $1`,
      [name],
    );
    if (exists.rowCount) {
      skipped++;
      continue;
    }
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_DIR, name, 'migration.sql'),
      'utf8',
    );
    // checksum compatible enough for deploy (prisma also stores checksum)
    const crypto = require('crypto');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    await c.query(
      `INSERT INTO "_prisma_migrations"
        ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
       VALUES ($1, $2, now(), $3, NULL, NULL, now(), 1)`,
      [
        crypto.randomUUID(),
        checksum,
        name,
      ],
    );
    inserted++;
    console.log(`  applied(mark): ${name}`);
  }

  console.log(`\n✅ baseline done: inserted=${inserted}, skipped=${skipped}`);
  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
