import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportSPKI, generateKeyPair } from 'jose';
import corpus from '../../../packages/core/test/fixtures/recurrence.json' with { type: 'json' };
import { MAX_WINDOW_DAYS, expandEvent } from '@gnomon/core';
import type { CalendarEvent, CalendarId, EventId, EventTiming, QueryWindow, TenantId } from '@gnomon/core';
import { InMemoryKeyRegistry, registerSpkiKey } from '../src/auth/registry.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { toEventRow } from '../src/db/events.js';
import { createApp } from '../src/http/app.js';
import {
  NO_DATABASE_MESSAGE,
  createTestDatabase,
  findAdminUrl,
  type TestDatabase,
} from './support/database.js';

/**
 * The read API, end to end: a real token, real RLS, real expansion.
 *
 * Uses Hono's `app.request`, which runs the whole stack -- middleware,
 * routing, validation -- without binding a socket.
 */

const adminUrl = await findAdminUrl();
const available = adminUrl !== null;
if (!available && !process.env.CI) console.warn(`\n${NO_DATABASE_MESSAGE}\n`);

const TENANT_A = 'tenant-a' as TenantId;
const TENANT_B = 'tenant-b' as TenantId;

let harness: TestDatabase;
let db: Database;
let app: ReturnType<typeof createApp>;
let registry: InMemoryKeyRegistry;
let keys: Record<string, CryptoKeyPair> = {};
let calA1: string;
let calA2: string;
let calB1: string;

beforeAll(async () => {
  if (!available) return;
  harness = await createTestDatabase(adminUrl as string);

  registry = new InMemoryKeyRegistry();
  for (const [kid, tenant] of [
    ['key-a', TENANT_A],
    ['key-b', TENANT_B],
  ] as const) {
    keys[kid] = (await generateKeyPair('Ed25519', { extractable: true })) as CryptoKeyPair;
    await registerSpkiKey(registry, {
      kid,
      tenantId: tenant,
      spki: await exportSPKI(keys[kid]!.publicKey),
    });
  }

  await harness.owner.query(`INSERT INTO tenants (id, name) VALUES ($1,$1), ($2,$2)`, [
    TENANT_A,
    TENANT_B,
  ]);

  const calendar = async (tenant: string, name: string) =>
    (
      await harness.owner.query<{ id: string }>(
        `INSERT INTO calendars (tenant_id, name, time_zone)
         VALUES ($1,$2,'America/New_York') RETURNING id`,
        [tenant, name],
      )
    ).rows[0]!.id;

  calA1 = await calendar(TENANT_A, 'A maintenance');
  calA2 = await calendar(TENANT_A, 'A community');
  calB1 = await calendar(TENANT_B, 'B maintenance');

  // The same weekly series that crosses the 2026 US spring-forward, so the
  // API is exercised on the case the corpus exists for.
  await seedEvent(TENANT_A, calA1, {
    uid: 'weekly@a',
    title: 'A weekly',
    timing: { kind: 'timed', start: '2026-03-01T09:00:00', end: '2026-03-01T10:00:00', timeZone: 'America/New_York' },
    recurrence: 'FREQ=WEEKLY;COUNT=4',
  });
  await seedEvent(TENANT_A, calA2, {
    uid: 'holiday@a',
    title: 'A holiday',
    timing: { kind: 'allDay', startDate: '2026-03-10', endDate: '2026-03-11' },
  });
  await seedEvent(TENANT_B, calB1, {
    uid: 'weekly@b',
    title: 'B weekly',
    timing: { kind: 'timed', start: '2026-03-01T09:00:00', end: '2026-03-01T10:00:00', timeZone: 'America/New_York' },
    recurrence: 'FREQ=WEEKLY;COUNT=4',
  });

  db = createDatabase(replaceCredentials(adminUrl as string, harness.databaseName));
  app = createApp({ db, registry });
}, 60_000);

afterAll(async () => {
  await db?.close();
  await harness?.destroy();
});

function replaceCredentials(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  parsed.username = `${database}_app`;
  parsed.password = 'test';
  return parsed.toString();
}

async function seedEvent(
  tenant: TenantId,
  calendarId: string,
  input: {
    uid: string;
    title: string;
    timing: EventTiming;
    recurrence?: string;
    exceptionDates?: string[];
  },
) {
  const row = toEventRow({
    id: '00000000-0000-4000-8000-000000000000' as EventId,
    tenantId: tenant,
    calendarId: calendarId as CalendarId,
    uid: input.uid,
    title: input.title,
    timing: input.timing,
    ...(input.recurrence ? { recurrence: input.recurrence } : {}),
    ...(input.exceptionDates ? { exceptionDates: input.exceptionDates } : {}),
  });

  await harness.owner.query(
    `INSERT INTO events (tenant_id, calendar_id, uid, title, timing_kind, start_local, end_local,
       time_zone, start_date, end_date, recurrence, exception_dates, search_span)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      row.tenantId, row.calendarId, row.uid, row.title, row.timingKind, row.startLocal,
      row.endLocal, row.timeZone, row.startDate, row.endDate, row.recurrence,
      row.exceptionDates, row.searchSpan,
    ],
  );
}

async function mint(options: {
  kid?: string;
  tenant?: TenantId;
  calendars?: string[];
  scopes?: string[];
} = {}) {
  const kid = options.kid ?? 'key-a';
  return new SignJWT({
    cal: options.calendars ?? [calA1, calA2],
    scp: options.scopes ?? ['events:read'],
    tid: options.tenant ?? TENANT_A,
    sub: 'resident-42',
  })
    .setProtectedHeader({ alg: 'EdDSA', kid })
    .setAudience('gnomon')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys[kid]!.privateKey);
}

const get = async (path: string, token?: string, headers: Record<string, string> = {}) =>
  app.request(path, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  });

describe.skipIf(!available)('authentication', () => {
  it('rejects a request with no token', async () => {
    const res = await get('/calendars');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toMatch(/Bearer/);
  });

  it('does not leak why a token was rejected', async () => {
    // "unknown key" vs "bad signature" tells an attacker which half of their
    // guess was right. It belongs in logs, not the response.
    const res = await get('/calendars', 'not-a-jwt');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('leaves /health open', async () => {
    expect((await get('/health')).status).toBe(200);
  });
});

describe.skipIf(!available)('GET /calendars', () => {
  it('returns only the calendars the token grants', async () => {
    const res = await get('/calendars', await mint({ calendars: [calA1] }));
    const body = (await res.json()) as { calendars: { id: string; name: string }[] };

    expect(res.status).toBe(200);
    expect(body.calendars.map((c) => c.name)).toEqual(['A maintenance']);
  });

  it('never returns another tenant\'s calendar even when the token names it', async () => {
    // Tenant A's key, but asking for tenant B's calendar id. The `cal` claim
    // is filtered by `permits`, and RLS independently makes the row invisible
    // -- either alone would be enough, which is the point.
    const res = await get('/calendars', await mint({ calendars: [calA1, calB1] }));
    const body = (await res.json()) as { calendars: { id: string }[] };

    expect(body.calendars.map((c) => c.id)).toEqual([calA1]);
  });
});

describe.skipIf(!available)('GET /calendars/{id}', () => {
  it('returns a granted calendar', async () => {
    const res = await get(`/calendars/${calA1}`, await mint());
    expect(res.status).toBe(200);
    expect((await res.json() as { name: string }).name).toBe('A maintenance');
  });

  it('reports another tenant\'s calendar as 404, not 403', async () => {
    // 403 would confirm the id exists, which is a membership oracle across
    // tenants. Absent and forbidden must be indistinguishable here.
    const res = await get(`/calendars/${calB1}`, await mint({ calendars: [calA1, calB1] }));
    expect(res.status).toBe(404);
  });
});

describe.skipIf(!available)('GET /events', () => {
  const march = 'from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z';

  it('expands occurrences and holds wall-clock time across spring-forward', async () => {
    const res = await get(`/events?${march}&tz=America/New_York&calendarId=${calA1}`, await mint());
    const body = (await res.json()) as { occurrences: { timing: { start: string } }[] };

    expect(res.status).toBe(200);
    expect(body.occurrences.map((o) => o.timing.start)).toEqual([
      '2026-03-01T09:00:00',
      '2026-03-08T09:00:00',
      '2026-03-15T09:00:00',
      '2026-03-22T09:00:00',
    ]);
  });

  it('defaults to every calendar the token grants', async () => {
    const res = await get(`/events?${march}&tz=America/New_York`, await mint());
    const body = (await res.json()) as { occurrences: { calendarId: string }[] };
    expect(new Set(body.occurrences.map((o) => o.calendarId))).toEqual(new Set([calA1, calA2]));
  });

  it('returns nothing for a calendar the token does not grant', async () => {
    const res = await get(`/events?${march}&calendarId=${calB1}`, await mint());
    expect((await res.json() as { occurrences: unknown[] }).occurrences).toEqual([]);
  });

  it('cannot reach another tenant\'s events with a forged calendar id', async () => {
    // Even if the claim carried it, RLS makes the rows invisible.
    const res = await get(`/events?${march}&calendarId=${calB1}`, await mint({ calendars: [calB1] }));
    expect((await res.json() as { occurrences: unknown[] }).occurrences).toEqual([]);
  });

  it('rejects a window past the cap, naming the limit', async () => {
    const res = await get('/events?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z', await mint());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'window_too_large', limit: MAX_WINDOW_DAYS });
  });

  it('rejects an inverted window', async () => {
    const res = await get('/events?from=2026-04-01T00:00:00Z&to=2026-03-01T00:00:00Z', await mint());
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('invalid_window');
  });

  it('rejects a missing window rather than defaulting to one', async () => {
    const res = await get('/events?tz=UTC', await mint());
    expect(res.status).toBe(400);
  });

  it('renders all-day events against the requested zone', async () => {
    // The holiday is 2026-03-10 floating. Asking from a zone where that date
    // has not begun at the window edge must exclude it (ADR-0005).
    const inZone = await get(
      `/events?from=2026-03-10T00:00:00Z&to=2026-03-10T06:00:00Z&tz=Pacific/Auckland&calendarId=${calA2}`,
      await mint(),
    );
    const outOfZone = await get(
      `/events?from=2026-03-10T00:00:00Z&to=2026-03-10T06:00:00Z&tz=Pacific/Honolulu&calendarId=${calA2}`,
      await mint(),
    );

    expect((await inZone.json() as { occurrences: unknown[] }).occurrences).toHaveLength(1);
    expect((await outOfZone.json() as { occurrences: unknown[] }).occurrences).toEqual([]);
  });
});

describe.skipIf(!available)('ETag and conditional GET', () => {
  const march = 'from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z&tz=America/New_York';

  it('returns 304 when the client already has this body', async () => {
    const token = await mint();
    const first = await get(`/events?${march}`, token);
    const etag = first.headers.get('ETag');

    expect(etag).toBeTruthy();

    const second = await get(`/events?${march}`, token, { 'If-None-Match': etag as string });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  it('varies the ETag by tenant even when the bodies are identical', async () => {
    // THE cache-poisoning case. Both tenants request a window with no events,
    // so both bodies are byte-identical -- if the validator came from the body
    // alone they would share one, and a cache keyed on URL would be one
    // If-None-Match away from confirming another tenant's content.
    const empty = 'from=2030-01-01T00:00:00Z&to=2030-02-01T00:00:00Z&tz=UTC';

    const a = await get(`/events?${empty}`, await mint({ kid: 'key-a', calendars: [calA1] }));
    const b = await get(
      `/events?${empty}`,
      await mint({ kid: 'key-b', tenant: TENANT_B, calendars: [calB1] }),
    );

    expect(await a.text()).toBe(await b.text());
    expect(a.headers.get('ETag')).not.toBe(b.headers.get('ETag'));
  });

  it('does not honour another tenant\'s ETag', async () => {
    const empty = 'from=2030-01-01T00:00:00Z&to=2030-02-01T00:00:00Z&tz=UTC';
    const a = await get(`/events?${empty}`, await mint({ calendars: [calA1] }));

    const b = await get(
      `/events?${empty}`,
      await mint({ kid: 'key-b', tenant: TENANT_B, calendars: [calB1] }),
      { 'If-None-Match': a.headers.get('ETag') as string },
    );

    expect(b.status).toBe(200);
  });

  it('changes the ETag when the rendering zone changes', async () => {
    const token = await mint();
    const utc = await get(`/events?from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z&tz=UTC`, token);
    const nyc = await get(`/events?${march}`, token);
    expect(utc.headers.get('ETag')).not.toBe(nyc.headers.get('ETag'));
  });

  it('marks responses private and varying on Authorization', async () => {
    const res = await get(`/events?${march}`, await mint());
    expect(res.headers.get('Cache-Control')).toContain('private');
    expect(res.headers.get('Vary')).toContain('Authorization');
  });
});

describe.skipIf(!available)('OpenAPI', () => {
  it('serves a spec generated from the Zod schemas', async () => {
    const res = await get('/openapi.json');
    expect(res.status).toBe(200);

    const spec = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };

    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths).sort()).toEqual(['/calendars', '/calendars/{id}', '/events']);
    // Generated from the same definitions the handlers validate against, so a
    // schema change cannot drift from the documented contract.
    expect(spec.components.schemas).toHaveProperty('EventOccurrence');
    expect(spec.components.schemas).toHaveProperty('Calendar');
  });

  it('documents the window cap where a client will look for it', async () => {
    const spec = (await (await get('/openapi.json')).json()) as Record<string, any>;
    expect(JSON.stringify(spec)).toContain(String(MAX_WINDOW_DAYS));
  });
});

// ---------------------------------------------------------------------------
// The exit criterion
// ---------------------------------------------------------------------------

describe.skipIf(!available)('HTTP expansion matches @gnomon/core exactly', () => {
  interface Fixture {
    name: string;
    timing: EventTiming;
    recurrence?: string;
    exceptionDates?: string[];
    renderTimeZone?: string;
    window: QueryWindow;
  }

  const fixtures = (corpus as Fixture[]).filter((f) => {
    // Windows wider than the cap belong to core's unit tests; the HTTP layer
    // refuses them by design and that is asserted separately above.
    const days = (Date.parse(f.window.to) - Date.parse(f.window.from)) / 86_400_000;
    return days <= MAX_WINDOW_DAYS;
  });

  it('is running against the real corpus', () => {
    expect(fixtures.length).toBeGreaterThan(15);
  });

  for (const [index, fixture] of fixtures.entries()) {
    it(`matches core for: ${fixture.name}`, async () => {
      // The API must call core and serialise the result. Any transformation
      // here would make the HTTP layer disagree with the corpus, which is the
      // one place recurrence correctness is actually established.
      const uid = `corpus-${index}@a`;
      await seedEvent(TENANT_A, calA1, {
        uid,
        title: fixture.name,
        timing: fixture.timing,
        ...(fixture.recurrence ? { recurrence: fixture.recurrence } : {}),
        ...(fixture.exceptionDates ? { exceptionDates: fixture.exceptionDates } : {}),
      });

      try {
        const tz = fixture.renderTimeZone ?? 'UTC';
        const res = await get(
          `/events?from=${encodeURIComponent(fixture.window.from)}&to=${encodeURIComponent(fixture.window.to)}` +
            `&tz=${encodeURIComponent(tz)}&calendarId=${calA1}`,
          await mint({ calendars: [calA1] }),
        );

        const body = (await res.json()) as { occurrences: { title: string; timing: EventTiming }[] };
        const overHttp = body.occurrences
          .filter((o) => o.title === fixture.name)
          .map((o) => o.timing);

        const event: CalendarEvent = {
          id: 'x' as EventId,
          tenantId: TENANT_A,
          calendarId: calA1 as CalendarId,
          uid,
          title: fixture.name,
          timing: fixture.timing,
          ...(fixture.recurrence ? { recurrence: fixture.recurrence } : {}),
          ...(fixture.exceptionDates ? { exceptionDates: fixture.exceptionDates } : {}),
        };
        const direct = expandEvent(event, fixture.window, { renderTimeZone: tz }).map((o) => o.timing);

        expect(overHttp).toEqual(direct);
      } finally {
        await harness.owner.query('DELETE FROM events WHERE uid = $1', [uid]);
      }
    });
  }
});

describe('database availability', () => {
  it('did not silently skip the API suite in CI', () => {
    if (!available && process.env.CI) {
      throw new Error(`API suite skipped in CI.\n\n${NO_DATABASE_MESSAGE}`);
    }
    expect(available || !process.env.CI).toBe(true);
  });
});
