import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import {
  NO_DATABASE_MESSAGE,
  createTestDatabase,
  findAdminUrl,
  type TestDatabase,
} from './support/database.js';

/**
 * Tenant isolation, proven against a real Postgres.
 *
 * Every assertion here runs through the APPLICATION pool -- a role that is not
 * superuser, does not own the tables, and has no BYPASSRLS. Running these as
 * the owner or as `postgres` would make them pass while proving nothing, which
 * is the failure mode that makes RLS suites worthless.
 */

const adminUrl = await findAdminUrl();
const available = adminUrl !== null;

if (!available && !process.env.CI) {
  console.warn(`\n${NO_DATABASE_MESSAGE}\n`);
}

let db: TestDatabase;

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
let calendarA: string;
let calendarB: string;
let eventA: string;
let eventB: string;

beforeAll(async () => {
  if (!available) return;
  db = await createTestDatabase(adminUrl as string);

  // Seeded as the OWNER, which bypasses nothing here but keeps fixture setup
  // independent of the policies under test.
  await db.owner.query(`INSERT INTO tenants (id, name) VALUES ($1,$1), ($2,$2)`, [
    TENANT_A,
    TENANT_B,
  ]);

  const seedCalendar = async (tenant: string, name: string) =>
    (
      await db.owner.query<{ id: string }>(
        `INSERT INTO calendars (tenant_id, name, time_zone) VALUES ($1,$2,'America/New_York') RETURNING id`,
        [tenant, name],
      )
    ).rows[0]!.id;

  calendarA = await seedCalendar(TENANT_A, 'A maintenance');
  calendarB = await seedCalendar(TENANT_B, 'B maintenance');

  const seedEvent = async (tenant: string, calendar: string, title: string) =>
    (
      await db.owner.query<{ id: string }>(
        `INSERT INTO events (tenant_id, calendar_id, uid, title, timing_kind,
           start_local, end_local, time_zone, search_span)
         VALUES ($1,$2,$3,$4,'timed','2026-06-01T09:00:00','2026-06-01T10:00:00',
           'America/New_York', '[2026-06-01T13:00:00Z,2026-06-01T14:00:00Z)')
         RETURNING id`,
        [tenant, calendar, `${title}@gnomon.test`, title],
      )
    ).rows[0]!.id;

  eventA = await seedEvent(TENANT_A, calendarA, 'A private standup');
  eventB = await seedEvent(TENANT_B, calendarB, 'B private standup');
}, 60_000);

afterAll(async () => {
  await db?.destroy();
});

/** Runs `work` in a transaction with the tenant context set, as the app role. */
async function asTenant<T>(tenant: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.app.connect();
  try {
    await client.query('BEGIN');
    // Transaction-local (`true`), so a pooled connection cannot carry tenant
    // context into whoever checks it out next.
    await client.query(`SELECT set_config('gnomon.tenant_id', $1, true)`, [tenant]);
    return await work(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

describe.skipIf(!available)('the application role is actually unprivileged', () => {
  it('is neither superuser nor BYPASSRLS, and owns nothing', async () => {
    // If this is wrong, every other test in this file is theatre.
    const { rows } = await db.app.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      owns: string;
    }>(
      `SELECT r.rolsuper, r.rolbypassrls,
              (SELECT count(*) FROM pg_class c
                 WHERE c.relowner = r.oid AND c.relkind = 'r')::text AS owns
         FROM pg_roles r WHERE r.rolname = current_user`,
    );

    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
    expect(rows[0]?.owns).toBe('0');
  });

  it('has RLS enabled AND forced on every covered table', async () => {
    const { rows } = await db.app.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('calendars','events','recurrence_overrides','feed_tokens','ics_sources','audit_log')
        ORDER BY relname`,
    );

    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} has RLS disabled`).toBe(true);
      // Without FORCE, the owner bypasses policies -- and the migration role
      // is usually the owner.
      expect(row.relforcerowsecurity, `${row.relname} is not FORCEd`).toBe(true);
    }
  });
});

describe.skipIf(!available)('tenant isolation', () => {
  it('shows a tenant only its own events', async () => {
    const titles = await asTenant(TENANT_A, async (client) =>
      (await client.query<{ title: string }>('SELECT title FROM events')).rows.map((r) => r.title),
    );
    expect(titles).toEqual(['A private standup']);
  });

  it('returns nothing for another tenant even with a FORGED calendar id', async () => {
    // The phase's headline exit criterion. Tenant A knows tenant B's calendar
    // id -- ids are not secrets, they travel in URLs and tokens -- and asks
    // for it directly. RLS answers with silence rather than a permission
    // error, which is the correct shape: the row does not exist for them.
    const rows = await asTenant(TENANT_A, async (client) =>
      (await client.query('SELECT * FROM events WHERE calendar_id = $1', [calendarB])).rows,
    );
    expect(rows).toEqual([]);
  });

  it('returns nothing when asked for another tenant\'s event by primary key', async () => {
    const rows = await asTenant(TENANT_A, async (client) =>
      (await client.query('SELECT * FROM events WHERE id = $1', [eventB])).rows,
    );
    expect(rows).toEqual([]);
  });

  it('cannot UPDATE another tenant\'s row', async () => {
    const result = await asTenant(TENANT_A, async (client) =>
      client.query('UPDATE events SET title = $1 WHERE id = $2', ['pwned', eventB]),
    );
    // Zero rows matched, because the row is invisible. The write is a no-op
    // rather than an error, so a caller must never infer success from the
    // absence of an exception.
    expect(result.rowCount).toBe(0);

    const stillIntact = await db.owner.query<{ title: string }>(
      'SELECT title FROM events WHERE id = $1',
      [eventB],
    );
    expect(stillIntact.rows[0]?.title).toBe('B private standup');
  });

  it('cannot DELETE another tenant\'s row', async () => {
    const result = await asTenant(TENANT_A, async (client) =>
      client.query('DELETE FROM events WHERE id = $1', [eventB]),
    );
    expect(result.rowCount).toBe(0);
  });

  it('cannot INSERT a row belonging to another tenant', async () => {
    // This is what WITH CHECK buys. Without it, tenant A could write rows
    // INTO tenant B -- which surfaces as a data-integrity puzzle long before
    // anyone recognises it as a tenancy breach.
    await expect(
      asTenant(TENANT_A, async (client) =>
        client.query(
          `INSERT INTO events (tenant_id, calendar_id, uid, title, timing_kind,
             start_local, end_local, time_zone, search_span)
           VALUES ($1,$2,'smuggled@test','Smuggled','timed','2026-06-01T09:00:00',
             '2026-06-01T10:00:00','America/New_York','[2026-06-01T13:00:00Z,2026-06-01T14:00:00Z)')`,
          [TENANT_B, calendarB],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('sees nothing at all when no tenant context is set', async () => {
    // current_setting(..., true) is NULL when unset, and `tenant_id = NULL` is
    // never true. The policy fails CLOSED, which is the only acceptable
    // default -- a bug that forgets to set the context must show an empty
    // calendar, not everyone's.
    const client = await db.app.connect();
    try {
      const { rows } = await client.query('SELECT * FROM events');
      expect(rows).toEqual([]);
    } finally {
      client.release();
    }
  });
});

describe.skipIf(!available)('tenant context does not leak across pooled connections', () => {
  it('does not carry a transaction-local setting into the next checkout', async () => {
    // The pool has more than one connection and reuses them. If the context
    // were set with `set_config(..., false)` or a plain SET, it would persist
    // on the physical connection and the NEXT request -- possibly another
    // tenant's -- would inherit it.
    await asTenant(TENANT_A, async (client) => {
      const { rows } = await client.query<{ t: string }>(
        `SELECT current_setting('gnomon.tenant_id', true) AS t`,
      );
      expect(rows[0]?.t).toBe(TENANT_A);
    });

    // Drain the pool so we are very likely to get a connection that has
    // previously served tenant A.
    const observed = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const client = await db.app.connect();
        try {
          const { rows } = await client.query<{ t: string | null }>(
            `SELECT current_setting('gnomon.tenant_id', true) AS t`,
          );
          return rows[0]?.t ?? null;
        } finally {
          client.release();
        }
      }),
    );

    expect(observed.every((value) => value === null || value === '')).toBe(true);
  });

  it('isolates concurrent tenants sharing the pool', async () => {
    const [aTitles, bTitles] = await Promise.all([
      asTenant(TENANT_A, async (client) =>
        (await client.query<{ title: string }>('SELECT title FROM events')).rows.map((r) => r.title),
      ),
      asTenant(TENANT_B, async (client) =>
        (await client.query<{ title: string }>('SELECT title FROM events')).rows.map((r) => r.title),
      ),
    ]);

    expect(aTitles).toEqual(['A private standup']);
    expect(bTitles).toEqual(['B private standup']);
  });
});

describe.skipIf(!available)('the negative controls', () => {
  it('proves the suite can fail: with RLS disabled, the app role sees every tenant', async () => {
    // If turning the boundary off did NOT leak, every isolation test above
    // would be passing for some reason other than RLS -- and we would have no
    // way to tell.
    await db.owner.query('ALTER TABLE events DISABLE ROW LEVEL SECURITY');
    try {
      const titles = await asTenant(TENANT_A, async (client) =>
        (await client.query<{ title: string }>('SELECT title FROM events')).rows.map((r) => r.title),
      );
      expect(titles.sort()).toEqual(['A private standup', 'B private standup']);
    } finally {
      await db.owner.query('ALTER TABLE events ENABLE ROW LEVEL SECURITY');
      await db.owner.query('ALTER TABLE events FORCE ROW LEVEL SECURITY');
    }

    // Restored, and isolating again.
    const titles = await asTenant(TENANT_A, async (client) =>
      (await client.query<{ title: string }>('SELECT title FROM events')).rows.map((r) => r.title),
    );
    expect(titles).toEqual(['A private standup']);
  });

  it('denies everything when RLS is on but no policy exists', async () => {
    // Postgres defaults to DENY when a table has RLS enabled and no policy
    // matches -- not to allow. Worth pinning: it means a future table that
    // gets `ENABLE ROW LEVEL SECURITY` but whose policy is forgotten returns
    // an empty calendar rather than everyone's.
    await db.owner.query('DROP POLICY events_tenant_isolation ON events');
    try {
      const titles = await asTenant(TENANT_A, async (client) =>
        (await client.query<{ title: string }>('SELECT title FROM events')).rows.map((r) => r.title),
      );
      expect(titles).toEqual([]);
    } finally {
      await db.owner.query(
        `CREATE POLICY events_tenant_isolation ON events
           USING (tenant_id = current_setting('gnomon.tenant_id', true))
           WITH CHECK (tenant_id = current_setting('gnomon.tenant_id', true))`,
      );
    }
  });

  it('a SUPERUSER bypasses RLS entirely, FORCE or not', async () => {
    // Documented as a test because it is the single easiest way to deploy this
    // system with tenancy silently switched off, and it is invisible from the
    // application's side -- no error, no warning, every query just works and
    // returns too much.
    //
    // `db.owner` is a superuser here (Postgres.app's `tim` locally, `postgres`
    // in CI), which is exactly why every isolation assertion in this file runs
    // through `db.app` instead. FORCE constrains a non-superuser OWNER; it
    // does nothing to a superuser.
    const isSuper = await db.owner.query<{ rolsuper: boolean }>(
      `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`,
    );
    expect(isSuper.rows[0]?.rolsuper, 'this control assumes the owner pool is a superuser').toBe(
      true,
    );

    const client = await db.owner.connect();
    try {
      await client.query(`SELECT set_config('gnomon.tenant_id', $1, true)`, [TENANT_A]);
      const { rows } = await client.query<{ title: string }>('SELECT title FROM events');
      // Tenant context set, FORCE enabled, policy in place -- and both tenants
      // come back anyway. See scripts/create-app-role.sql.
      expect(rows.length).toBeGreaterThan(1);
    } finally {
      client.release();
    }
  });
});

describe('database availability', () => {
  it('did not silently skip the tenancy suite in CI', () => {
    // Locally a missing Postgres is a skip with an explanation. In CI it is a
    // failure: CI is where the tenancy guarantee is actually kept, and a
    // green build that never ran these tests is worse than a red one.
    if (!available && process.env.CI) {
      throw new Error(`RLS suite skipped in CI.\n\n${NO_DATABASE_MESSAGE}`);
    }
    expect(available || !process.env.CI).toBe(true);
  });
});
