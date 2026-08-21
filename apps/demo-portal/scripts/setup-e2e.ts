import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

/**
 * Prepares a real database for the hostile-host suite.
 *
 * This suite is deliberately end to end: a real Gnomon server, a real host
 * portal on a different origin, real tokens signed with a real key. Mocking
 * any of it would remove the thing being tested -- the whole point is that a
 * pasted script tag survives contact with someone else's page.
 *
 * There is therefore no "skip if no database" path here, unlike the server
 * suites. A hostile-host test with no host is not a reduced test, it is no
 * test, and pretending otherwise is how a suite quietly stops covering the
 * thing it exists for.
 *
 * Run BEFORE Playwright rather than as its `globalSetup`, because Playwright
 * starts `webServer` first and only then runs globalSetup -- so a database
 * created there does not exist yet when the servers boot. The resulting URL
 * is handed over in a file, which the config reads.
 */

const SERVER_DIR = fileURLToPath(new URL('../../server', import.meta.url));
const DB_NAME = 'gnomon_hostile_e2e';

const CANDIDATE_PORTS = [5433, 5432];
const CANDIDATE_USERS = ['postgres', 'gnomon', process.env.USER ?? 'postgres'];

async function findAdminUrl(): Promise<string | null> {
  if (process.env.GNOMON_TEST_DATABASE_URL) return process.env.GNOMON_TEST_DATABASE_URL;

  for (const port of CANDIDATE_PORTS) {
    for (const user of [...new Set(CANDIDATE_USERS)]) {
      for (const url of [
        `postgres://${user}:${user}@127.0.0.1:${port}/postgres`,
        `postgres://${user}@127.0.0.1:${port}/postgres`,
      ]) {
        const client = new Client({ connectionString: url, connectionTimeoutMillis: 1500 });
        try {
          await client.connect();
          await client.end();
          return url;
        } catch {
          await client.end().catch(() => {});
        }
      }
    }
  }
  return null;
}

const ENV_FILE = fileURLToPath(new URL('../.e2e-env.json', import.meta.url));

async function main(): Promise<void> {
  const adminUrl = await findAdminUrl();
  if (!adminUrl) {
    throw new Error(
      [
        'The hostile-host suite needs a real Postgres and found none.',
        '',
        'It runs a real Gnomon server against a real database, because the point',
        'is that a pasted script tag survives a real host page. Any one of these:',
        '  * Postgres.app, or brew install postgresql@17',
        '  * docker compose up -d postgres   (maps 5433)',
        '  * GNOMON_TEST_DATABASE_URL=postgres://user:pass@host:port/postgres',
      ].join('\n'),
    );
  }

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Dropped and recreated each run: the seed is not idempotent across
    // schema changes, and a half-migrated database fails in ways that look
    // like product bugs.
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await admin.end();
  }

  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${DB_NAME}`;
  const env = { ...process.env, DATABASE_URL: databaseUrl.toString() };

  execFileSync('pnpm', ['exec', 'drizzle-kit', 'migrate'], { cwd: SERVER_DIR, env, stdio: 'pipe' });
  execFileSync('pnpm', ['exec', 'tsx', 'src/seed.ts'], {
    cwd: SERVER_DIR,
    // The seed writes the demo private key, which the portal signs with.
    env: { ...env, DEMO_KEY_OUT: '.demo-key.pem' },
    stdio: 'pipe',
  });

  writeFileSync(ENV_FILE, JSON.stringify({ databaseUrl: databaseUrl.toString() }, null, 2));
  console.log(`e2e database ready: ${DB_NAME}`);
}

await main();
