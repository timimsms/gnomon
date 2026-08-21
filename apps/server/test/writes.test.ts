import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportSPKI, generateKeyPair } from 'jose';
import type { TenantId } from '@gnomon/core';
import { InMemoryKeyRegistry, registerSpkiKey } from '../src/auth/registry.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { hashFeedToken, mintFeedToken } from '../src/feeds/tokens.js';
import { createApp } from '../src/http/app.js';
import {
  NO_DATABASE_MESSAGE,
  createTestDatabase,
  findAdminUrl,
  type TestDatabase,
} from './support/database.js';

/**
 * The write path (phase 6).
 *
 * Against a real database and real RLS, because the two properties that
 * matter -- that a token cannot write outside its calendars, and that the
 * audit log cannot be rewritten -- are both enforced below the application.
 */

const adminUrl = await findAdminUrl();
const available = adminUrl !== null;
if (!available && !process.env.CI) console.warn(`\n${NO_DATABASE_MESSAGE}\n`);

const TENANT_A = 'tenant-a' as TenantId;
const TENANT_B = 'tenant-b' as TenantId;

let harness: TestDatabase;
let db: Database;
let app: ReturnType<typeof createApp>;
let keys: Record<string, CryptoKeyPair> = {};
let calA1: string;
let calA2: string;
let calB1: string;

beforeAll(async () => {
  if (!available) return;
  harness = await createTestDatabase(adminUrl as string);

  const registry = new InMemoryKeyRegistry();
  for (const [kid, tenant] of [['key-a', TENANT_A], ['key-b', TENANT_B]] as const) {
    keys[kid] = (await generateKeyPair('Ed25519', { extractable: true })) as CryptoKeyPair;
    await registerSpkiKey(registry, { kid, tenantId: tenant, spki: await exportSPKI(keys[kid]!.publicKey) });
  }

  await harness.owner.query(`INSERT INTO tenants (id, name) VALUES ($1,$1), ($2,$2)`, [TENANT_A, TENANT_B]);

  const calendar = async (tenant: string, name: string) =>
    (
      await harness.owner.query<{ id: string }>(
        `INSERT INTO calendars (tenant_id, name, time_zone) VALUES ($1,$2,'America/New_York') RETURNING id`,
        [tenant, name],
      )
    ).rows[0]!.id;

  calA1 = await calendar(TENANT_A, 'A maintenance');
  calA2 = await calendar(TENANT_A, 'A community');
  calB1 = await calendar(TENANT_B, 'B private');

  const url = new URL(adminUrl as string);
  url.pathname = `/${harness.databaseName}`;
  url.username = `${harness.databaseName}_app`;
  url.password = 'test';

  db = createDatabase(url.toString());
  app = createApp({ db, registry });
}, 60_000);

afterAll(async () => {
  await db?.close();
  await harness?.destroy();
});

async function mint(options: { kid?: string; tenant?: TenantId; calendars?: string[]; scopes?: string[] } = {}) {
  const kid = options.kid ?? 'key-a';
  return new SignJWT({
    cal: options.calendars ?? [calA1, calA2],
    scp: options.scopes ?? ['events:read', 'events:write'],
    tid: options.tenant ?? TENANT_A,
    sub: 'resident-42',
  })
    .setProtectedHeader({ alg: 'EdDSA', kid })
    .setAudience('gnomon')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys[kid]!.privateKey);
}

const TIMED = {
  kind: 'timed',
  start: '2026-06-01T09:00:00',
  end: '2026-06-01T10:00:00',
  timeZone: 'America/New_York',
};

async function post(calendarId: string, body: unknown, token?: string) {
  return app.request(`/calendars/${calendarId}/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function patch(eventId: string, body: unknown, token: string, headers: Record<string, string> = {}) {
  return app.request(`/events/${eventId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  });
}

async function createEvent(title = 'Inspection', calendarId = calA1) {
  const res = await post(calendarId, { title, timing: TIMED }, await mint());
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; version: number };
}

describe.skipIf(!available)('creating events', () => {
  it('a scoped token creates an event', async () => {
    const res = await post(calA1, { title: 'Boiler inspection', timing: TIMED }, await mint());

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; title: string; version: number };
    expect(body.title).toBe('Boiler inspection');
    expect(body.version).toBe(1);
    expect(res.headers.get('ETag')).toBe('"v1"');
  });

  it('an unscoped token gets 403', async () => {
    const res = await post(calA1, { title: 'Nope', timing: TIMED }, await mint({ scopes: ['events:read'] }));

    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('insufficient_scope');
    expect(res.headers.get('WWW-Authenticate')).toContain('events:write');
  });

  it('no token at all gets 401', async () => {
    expect((await post(calA1, { title: 'Nope', timing: TIMED })).status).toBe(401);
  });

  it('a token scoped to calendar A cannot write to calendar B in the SAME tenant', async () => {
    // RLS enforces the tenant boundary and cannot see this one: it knows
    // tenants, not which calendars a subject was granted.
    const token = await mint({ calendars: [calA1] });
    const res = await post(calA2, { title: 'Smuggled', timing: TIMED }, token);

    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('forbidden');
  });

  it('cannot write into another tenant even with a forged calendar claim', async () => {
    const token = await mint({ calendars: [calA1, calB1] });
    const res = await post(calB1, { title: 'Cross-tenant', timing: TIMED }, token);

    // Refused before the database, but even if it were not, RLS's WITH CHECK
    // would reject the insert.
    expect([403, 404]).toContain(res.status);

    const leaked = await harness.owner.query('SELECT count(*)::int AS n FROM events WHERE title = $1', [
      'Cross-tenant',
    ]);
    expect(leaked.rows[0]?.n).toBe(0);
  });

  it('accepts an all-day event and keeps it floating', async () => {
    const res = await post(
      calA1,
      { title: 'Holiday', timing: { kind: 'allDay', startDate: '2026-07-04', endDate: '2026-07-05' } },
      await mint(),
    );

    expect(res.status).toBe(201);
    expect((await res.json() as { timing: unknown }).timing).toEqual({
      kind: 'allDay',
      startDate: '2026-07-04',
      endDate: '2026-07-05',
    });
  });
});

describe.skipIf(!available)('recurrence is refused specifically', () => {
  it('rejects a create carrying an RRULE with a documented error', async () => {
    // A generic validation error here reads as a bug and gets filed as one.
    const res = await post(
      calA1,
      { title: 'Weekly', timing: TIMED, recurrence: 'FREQ=WEEKLY;COUNT=4' },
      await mint(),
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('recurrence_not_editable');
    expect(body.message).toMatch(/read-only/i);
  });

  it('refuses to modify an existing recurring event', async () => {
    const { rows } = await harness.owner.query<{ id: string }>(
      `INSERT INTO events (tenant_id, calendar_id, uid, title, timing_kind, start_local, end_local,
         time_zone, recurrence, search_span)
       VALUES ($1,$2,'recurring@a','Weekly sync','timed','2026-06-01T09:00:00','2026-06-01T10:00:00',
         'America/New_York','FREQ=WEEKLY;COUNT=4','[2026-06-01T13:00:00Z,)')
       RETURNING id`,
      [TENANT_A, calA1],
    );

    const res = await patch(rows[0]!.id, { title: 'Renamed' }, await mint());
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe('recurrence_not_editable');
  });

  it('refuses to delete a recurring event', async () => {
    const { rows } = await harness.owner.query<{ id: string }>(
      `SELECT id FROM events WHERE uid = 'recurring@a'`,
    );
    const res = await app.request(`/events/${rows[0]!.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await mint()}` },
    });
    expect(res.status).toBe(422);
  });
});

describe.skipIf(!available)('optimistic concurrency', () => {
  it('two tabs editing one event: the second gets 409, not a lost write', async () => {
    const created = await createEvent('Original');

    const first = await patch(created.id, { title: 'First writer' }, await mint(), { 'If-Match': '"v1"' });
    expect(first.status).toBe(200);
    expect(first.headers.get('ETag')).toBe('"v2"');

    // The second tab still believes it holds v1.
    const second = await patch(created.id, { title: 'Second writer' }, await mint(), { 'If-Match': '"v1"' });
    expect(second.status).toBe(409);
    expect((await second.json() as { error: string }).error).toBe('version_conflict');

    // The first writer's change survived; nothing was silently overwritten.
    const stored = await harness.owner.query<{ title: string }>('SELECT title FROM events WHERE id = $1', [
      created.id,
    ]);
    expect(stored.rows[0]?.title).toBe('First writer');
  });

  it('a 409 reports the current version so the client can re-read', async () => {
    const created = await createEvent('Versioned');
    await patch(created.id, { title: 'Bumped' }, await mint(), { 'If-Match': '"v1"' });

    const conflict = await patch(created.id, { title: 'Stale' }, await mint(), { 'If-Match': '"v1"' });
    expect(conflict.headers.get('ETag')).toBe('"v2"');
  });

  it('a request without If-Match still succeeds, for simple clients', async () => {
    // Concurrency control is opt-in: a single-tab client that never races
    // should not have to implement it.
    const created = await createEvent('Unguarded');
    expect((await patch(created.id, { title: 'Changed' }, await mint())).status).toBe(200);
  });
});

describe.skipIf(!available)('the audit log', () => {
  it('records every mutation with the opaque subject', async () => {
    const created = await createEvent('Audited');
    await patch(created.id, { title: 'Audited again' }, await mint(), { 'If-Match': '"v1"' });
    await app.request(`/events/${created.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await mint()}`, 'If-Match': '"v2"' },
    });

    const { rows } = await harness.owner.query<{ operation: string; subject: string }>(
      `SELECT operation, subject FROM audit_log WHERE event_id = $1 ORDER BY at`,
      [created.id],
    );

    expect(rows.map((r) => r.operation)).toEqual(['create', 'update', 'delete']);
    // Opaque: Gnomon never learns a name or an email (ADR-0004), so this log
    // only becomes meaningful joined against the host's own records.
    expect(rows.every((r) => r.subject === 'resident-42')).toBe(true);
  });

  it('captures before and after states', async () => {
    const created = await createEvent('Before');
    await patch(created.id, { title: 'After' }, await mint(), { 'If-Match': '"v1"' });

    const { rows } = await harness.owner.query<{ before: { title: string } | null; after: { title: string } | null }>(
      `SELECT before, after FROM audit_log WHERE event_id = $1 AND operation = 'update'`,
      [created.id],
    );

    expect(rows[0]?.before?.title).toBe('Before');
    expect(rows[0]?.after?.title).toBe('After');
  });

  it('records a deletion before the row is gone', async () => {
    // Auditing after the delete would leave nothing to record, and a log that
    // omits deletions is worse than no log.
    const created = await createEvent('Doomed');
    await app.request(`/events/${created.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await mint()}` },
    });

    const { rows } = await harness.owner.query<{ before: { title: string } | null }>(
      `SELECT before FROM audit_log WHERE event_id = $1 AND operation = 'delete'`,
      [created.id],
    );
    expect(rows[0]?.before?.title).toBe('Doomed');
  });

  it('is append-only: the application role cannot UPDATE or DELETE it', async () => {
    // Enforced by GRANT, not by convention. A compromised application cannot
    // rewrite its own history no matter what the code says.
    const created = await createEvent('Immutable');

    await expect(
      db.withTenant(TENANT_A, async ({ client }) =>
        client.query(`UPDATE audit_log SET operation = 'create' WHERE event_id = $1`, [created.id]),
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.withTenant(TENANT_A, async ({ client }) =>
        client.query('DELETE FROM audit_log WHERE event_id = $1', [created.id]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('is tenant-scoped like everything else', async () => {
    const visible = await db.withTenant(TENANT_B, async ({ client }) =>
      client.query('SELECT count(*)::int AS n FROM audit_log'),
    );
    expect(visible.rows[0]?.n).toBe(0);
  });
});

describe.skipIf(!available)('written events round-trip through the ICS feed', () => {
  it('appears in the feed exactly as written', async () => {
    // The phase 6 exit criterion, and a genuine end-to-end: the write path,
    // the row mapping, the serialiser and the feed all have to agree.
    const res = await post(
      calA1,
      { title: 'Feed round trip', location: 'Roof', timing: TIMED },
      await mint(),
    );
    expect(res.status).toBe(201);

    const { token, hash } = mintFeedToken();
    await harness.owner.query(
      `INSERT INTO feed_tokens (tenant_id, calendar_id, token_hash, label) VALUES ($1,$2,$3,'rt')`,
      [TENANT_A, calA1, hash],
    );

    const feed = await app.request(`/feeds/${token}.ics`);
    const body = await feed.text();

    expect(body).toContain('SUMMARY:Feed round trip');
    expect(body).toContain('LOCATION:Roof');
    // The space-vs-T normalisation from phase 5 holds for freshly written
    // rows too, not just seeded ones.
    expect(body).toContain('DTSTART;TZID=America/New_York:20260601T090000');
    expect(hashFeedToken(token)).toBe(hash);
  });
});
