/**
 * Apply sslmode=require + uselibpqcompat=true then run a child command
 * (Prisma CLI does not load prisma.service.ts).
 *
 * Usage: node scripts/with-pg-ssl.js prisma migrate deploy
 */
const { spawnSync } = require('child_process');
const path = require('path');

require('./lib/pg-ssl-url');

const bin = path.resolve(__dirname, '../node_modules/.bin');
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH || ''}`;

const args = process.argv.slice(2);
if (!args.length) {
  process.exit(0);
}

const [cmd, ...cmdArgs] = args;
const r = spawnSync(cmd, cmdArgs, {
  stdio: 'inherit',
  env: process.env,
  shell: false,
  cwd: path.resolve(__dirname, '..'),
});

process.exit(r.status ?? 1);
