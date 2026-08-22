#!/usr/bin/env node
/**
 * Creates the database if it does not exist, then migrates and seeds it.
 *
 * Exists because `createdb` is not reliably on PATH -- Postgres.app installs
 * are keg-only, and a quickstart whose first command is "not found" is worse
 * than no quickstart. Everything here goes through the `pg` client we already
 * depend on, so it works wherever the server itself works.
 *
 *   DATABASE_URL=postgres://localhost/gnomon pnpm db:bootstrap
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://localhost/gnomon';

const target = new URL(databaseUrl);
const name = target.pathname.replace(/^\//, '');
if (!name) {
  console.error(`DATABASE_URL has no database name: ${databaseUrl}`);
  process.exit(2);
}

// Connect to `postgres` to issue CREATE DATABASE, which cannot run from
// inside the database it creates.
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = '/postgres';

const admin = new Client({ connectionString: adminUrl.toString() });

try {
  await admin.connect();
} catch (error) {
  console.error(`Could not reach Postgres at ${adminUrl.host}.`);
  console.error('Start one first: Postgres.app, `brew services start postgresql@17`,');
  console.error('or `docker compose up -d postgres` (which maps 5433).\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

try {
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (rows.length === 0) {
    // Identifier, not a parameter -- CREATE DATABASE takes no bind params.
    // The name comes from the operator's own DATABASE_URL, and quoting keeps
    // an unusual but legitimate one working.
    await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    console.log(`Created database "${name}".`);
  } else {
    console.log(`Database "${name}" already exists.`);
  }
} finally {
  await admin.end();
}

const env = { ...process.env, DATABASE_URL: databaseUrl };
execFileSync('pnpm', ['exec', 'drizzle-kit', 'migrate'], { cwd: SERVER_DIR, env, stdio: 'inherit' });
execFileSync('pnpm', ['exec', 'tsx', 'src/seed.ts'], { cwd: SERVER_DIR, env, stdio: 'inherit' });
