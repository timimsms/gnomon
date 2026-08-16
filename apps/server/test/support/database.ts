import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

/**
 * Provisioning a real Postgres for tests, without requiring Docker.
 *
 * The phase plan said "testcontainers". Testcontainers hard-requires a Docker
 * daemon, which is the exact dependency we are routing around -- and it was
 * never the actual requirement. The requirement is *a real Postgres*, because
 * RLS cannot be tested against a mock and testing it against a superuser
 * connection tests nothing at all.
 *
 * So the harness takes a URL and does not care where it came from:
 *
 *   1. GNOMON_TEST_DATABASE_URL, if set        -- CI, or a deliberate choice
 *   2. a Postgres already listening locally    -- Postgres.app, brew, compose
 *   3. nothing: skip locally, FAIL in CI       -- see `requireDatabase`
 *
 * Testcontainers can slot back in whenever Docker returns; it only ever
 * produced a URL.
 */

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));

/** Ports we look at, in order: compose's mapped port first, then the default. */
const CANDIDATE_PORTS = [5433, 5432];

const ADMIN_CANDIDATES = ['postgres', 'gnomon', process.env.USER ?? 'postgres'];

export interface TestDatabase {
  /** Connects as the OWNER. Used for fixtures and for the negative controls. */
  readonly owner: Pool;
  /**
   * Connects as the application role: not superuser, not owner, no BYPASSRLS.
   * Every assertion about tenancy must go through this pool, or it proves
   * nothing.
   */
  readonly app: Pool;
  readonly databaseName: string;
  destroy(): Promise<void>;
}

let cachedAdminUrl: string | null | undefined;

/**
 * Finds a Postgres we can create databases on, or null.
 *
 * Deliberately quiet: a developer without Postgres should get a skip and a
 * clear message, not a wall of connection errors.
 */
export async function findAdminUrl(): Promise<string | null> {
  if (cachedAdminUrl !== undefined) return cachedAdminUrl;

  const explicit = process.env.GNOMON_TEST_DATABASE_URL;
  if (explicit) {
    cachedAdminUrl = (await canConnect(explicit)) ? explicit : null;
    return cachedAdminUrl;
  }

  for (const port of CANDIDATE_PORTS) {
    for (const user of dedupe(ADMIN_CANDIDATES)) {
      const url = `postgres://${user}:${user}@127.0.0.1:${port}/postgres`;
      if (await canConnect(url)) {
        cachedAdminUrl = url;
        return url;
      }
      // Postgres.app and a stock brew install use trust auth for the local
      // user, where supplying a password is harmless but a wrong one is not.
      const trustUrl = `postgres://${user}@127.0.0.1:${port}/postgres`;
      if (await canConnect(trustUrl)) {
        cachedAdminUrl = trustUrl;
        return trustUrl;
      }
    }
  }

  cachedAdminUrl = null;
  return null;
}

async function canConnect(url: string): Promise<boolean> {
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1500, max: 1 });
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * The message a developer sees when no Postgres is reachable. Worth being
 * specific: "skipped" with no explanation is how a suite quietly stops
 * covering the thing it exists to cover.
 */
export const NO_DATABASE_MESSAGE = [
  'No Postgres reachable, so the RLS suite was skipped.',
  '',
  'These tests prove tenant isolation and cannot run against a mock.',
  'Any ONE of these works:',
  '  * Postgres.app or `brew install postgresql@17 && brew services start postgresql@17`',
  '  * docker compose up -d postgres   (maps 5433)',
  '  * GNOMON_TEST_DATABASE_URL=postgres://user:pass@host:port/postgres',
].join('\n');

/**
 * Creates a scratch database, applies every migration, and creates the
 * application role with the same grants a real deployment gets.
 *
 * A fresh database per suite rather than a shared one with cleanup: RLS
 * behaviour depends on table ownership and role membership, and those are
 * exactly the things a half-cleaned database gets wrong.
 */
export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  // Date.now/Math.random are fine here (not a workflow script), but a counter
  // plus pid keeps names readable when several suites run in parallel.
  const databaseName = `gnomon_test_${process.pid}_${counter++}`;
  const appRole = `${databaseName}_app`;

  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)}`);
    await admin.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
  } finally {
    await admin.end().catch(() => {});
  }

  const ownerUrl = replaceDatabase(adminUrl, databaseName);
  const owner = new Pool({ connectionString: ownerUrl, max: 4 });

  for (const statement of migrationStatements()) {
    await owner.query(statement);
  }

  // The application role: LOGIN, and nothing else. No superuser, no
  // BYPASSRLS, owns nothing. Mirrors scripts/create-app-role.sql.
  await owner.query(`DROP ROLE IF EXISTS ${quoteIdent(appRole)}`);
  await owner.query(`CREATE ROLE ${quoteIdent(appRole)} LOGIN PASSWORD 'test'`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(appRole)}`);
  await owner.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON calendars, events, recurrence_overrides,
     feed_tokens, ics_sources TO ${quoteIdent(appRole)}`,
  );
  await owner.query(`GRANT SELECT ON tenants, tenant_keys TO ${quoteIdent(appRole)}`);
  // Append-only: no UPDATE, no DELETE. Phase 6.3 depends on this holding at
  // the grant level rather than in application code.
  await owner.query(`GRANT SELECT, INSERT ON audit_log TO ${quoteIdent(appRole)}`);

  const app = new Pool({
    connectionString: replaceCredentials(replaceDatabase(adminUrl, databaseName), appRole, 'test'),
    // Small but >1, so the pooled-context-leak test has more than one
    // connection to actually leak between.
    max: 3,
  });

  return {
    owner,
    app,
    databaseName,
    async destroy() {
      await app.end().catch(() => {});
      await owner.end().catch(() => {});

      const cleanup = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await cleanup.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
          [databaseName],
        );
        await cleanup.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)}`);
        await cleanup.query(`DROP ROLE IF EXISTS ${quoteIdent(appRole)}`);
      } finally {
        await cleanup.end().catch(() => {});
      }
    },
  };
}

let counter = 0;

/**
 * Splits the checked-in migrations on drizzle's statement separator.
 *
 * Reading the real files rather than re-deriving DDL is the point: this is
 * the same SQL a deployment applies, so a migration that would fail in
 * production fails here first.
 */
export function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .flatMap((file) =>
      readFileSync(join(MIGRATIONS, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0 && !isOnlyComments(statement)),
    );
}

function isOnlyComments(statement: string): boolean {
  return statement
    .split('\n')
    .every((line) => line.trim() === '' || line.trim().startsWith('--'));
}

/** Postgres identifier quoting. Names here are ours, but doubling is cheap. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function replaceDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function replaceCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Reports the local Postgres, for the skip message and for diagnostics. */
export function describeLocalPostgres(): string {
  try {
    return execFileSync('bash', ['-lc', 'command -v postgres || true'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
