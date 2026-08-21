import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CalendarId, EventId, TenantId } from '@gnomon/core';
import { InMemoryKeyRegistry } from '../src/auth/registry.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { toEventRow } from '../src/db/events.js';
import { hashFeedToken, mintFeedToken } from '../src/feeds/tokens.js';
import { createApp } from '../src/http/app.js';
import { resetFeedRateLimits } from '../src/http/feeds.js';
import {
  NO_DATABASE_MESSAGE,
  createTestDatabase,
  findAdminUrl,
  type TestDatabase,
} from './support/database.js';

/**
 * ICS feeds (phase 5).
 *
 * Against a real database, because the interesting part is precisely the bit
 * that cannot be mocked: resolving a token before any tenant context exists,
 * which RLS would otherwise make impossible.
 */

const adminUrl = await findAdminUrl();
const available = adminUrl !== null;
if (!available && !process.env.CI) console.warn(`\n${NO_DATABASE_MESSAGE}\n`);

const TENANT_A = 'tenant-a' as TenantId;
const TENANT_B = 'tenant-b' as TenantId;

let harness: TestDatabase;
let db: Database;
let app: ReturnType<typeof createApp>;
let calA: string;
let calB: string;
let feedA: string;
let feedB: string;
let revoked: string;

beforeAll(async () => {
  if (!available) return;
  harness = await createTestDatabase(adminUrl as string);

  await harness.owner.query(`INSERT INTO tenants (id, name) VALUES ($1,$1), ($2,$2)`, [
    TENANT_A,
    TENANT_B,
  ]);

  const calendar = async (tenant: string, name: string, tz = 'America/New_York') =>
    (
      await harness.owner.query<{ id: string }>(
        `INSERT INTO calendars (tenant_id, name, time_zone) VALUES ($1,$2,$3) RETURNING id`,
        [tenant, name, tz],
      )
    ).rows[0]!.id;

  calA = await calendar(TENANT_A, 'A maintenance');
  calB = await calendar(TENANT_B, 'B private');

  // A recurring event crossing the 2026 US spring-forward, plus a floating
  // all-day event -- the two shapes most likely to be mangled in transit.
  await seedEvent(TENANT_A, calA, {
    uid: 'weekly@a',
    title: 'Boiler inspection',
    timing: { kind: 'timed', start: '2026-03-01T09:00:00', end: '2026-03-01T10:00:00', timeZone: 'America/New_York' },
    recurrence: 'FREQ=WEEKLY;COUNT=6',
  });
  await seedEvent(TENANT_A, calA, {
    uid: 'holiday@a',
    title: 'Independence Day',
    timing: { kind: 'allDay', startDate: '2026-07-04', endDate: '2026-07-05' },
  });
  await seedEvent(TENANT_B, calB, {
    uid: 'secret@b',
    title: 'Tenant B private meeting',
    timing: { kind: 'timed', start: '2026-03-02T09:00:00', end: '2026-03-02T10:00:00', timeZone: 'America/New_York' },
  });

  feedA = await createFeed(TENANT_A, calA, 'A public feed');
  feedB = await createFeed(TENANT_B, calB, 'B feed');
  revoked = await createFeed(TENANT_A, calA, 'retired', true);

  db = createDatabase(appUrl(adminUrl as string, harness.databaseName));
  app = createApp({ db, registry: new InMemoryKeyRegistry() });
}, 60_000);

afterAll(async () => {
  await db?.close();
  await harness?.destroy();
});

beforeEach(() => {
  // Buckets are process-global; without this the tests interfere.
  resetFeedRateLimits();
});

function appUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  parsed.username = `${database}_app`;
  parsed.password = 'test';
  return parsed.toString();
}

async function seedEvent(
  tenant: TenantId,
  calendarId: string,
  input: { uid: string; title: string; timing: never | Record<string, unknown>; recurrence?: string },
) {
  const row = toEventRow({
    id: '00000000-0000-4000-8000-000000000000' as EventId,
    tenantId: tenant,
    calendarId: calendarId as CalendarId,
    uid: input.uid,
    title: input.title,
    timing: input.timing as never,
    ...(input.recurrence ? { recurrence: input.recurrence } : {}),
  });

  await harness.owner.query(
    `INSERT INTO events (tenant_id, calendar_id, uid, title, timing_kind, start_local, end_local,
       time_zone, start_date, end_date, recurrence, search_span)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      row.tenantId, row.calendarId, row.uid, row.title, row.timingKind, row.startLocal,
      row.endLocal, row.timeZone, row.startDate, row.endDate, row.recurrence, row.searchSpan,
    ],
  );
}

async function createFeed(tenant: string, calendarId: string, label: string, revoke = false) {
  const { token, hash } = mintFeedToken();
  await harness.owner.query(
    `INSERT INTO feed_tokens (tenant_id, calendar_id, token_hash, label, revoked_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [tenant, calendarId, hash, label, revoke ? new Date() : null],
  );
  return token;
}

const fetchFeed = (token: string, headers: Record<string, string> = {}) =>
  app.request(`/feeds/${token}.ics`, { headers });

describe.skipIf(!available)('serving a feed', () => {
  it('returns an ICS document for a valid token', async () => {
    const res = await fetchFeed(feedA);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toContain('.ics');

    const body = await res.text();
    expect(body.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(body.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
  });

  it('resolves the token even though RLS hides feed_tokens without a tenant', async () => {
    // The whole reason migration 0002 exists. A plain SELECT here matches
    // zero rows, because the policy reads a tenant we have not discovered
    // yet -- so every feed would 404.
    const direct = await db.withTenant(
      '',
      async ({ client }) =>
        client.query('SELECT count(*)::int AS n FROM feed_tokens WHERE token_hash = $1', [
          hashFeedToken(feedA),
        ]),
      { readOnly: true },
    );
    expect(direct.rows[0]?.n).toBe(0);

    // And yet the endpoint works.
    expect((await fetchFeed(feedA)).status).toBe(200);
  });

  it('emits recurring events as RRULE rather than expanded instances', async () => {
    // Expanding here would multiply the payload by the occurrence count and
    // discard the client's own expansion, which knows the user's timezone.
    const body = await (await fetchFeed(feedA)).text();

    expect(body).toContain('RRULE:FREQ=WEEKLY;COUNT=6');
    // Six occurrences, one VEVENT.
    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });

  it('carries the calendar name and timezone for the client to display', async () => {
    // The CALENDAR's name, not the feed token's label. The label is an
    // operator's note about which subscriber a token belongs to -- "Tim's
    // iPhone" would be a nonsensical thing to show as a calendar name.
    const body = await (await fetchFeed(feedA)).text();
    expect(body).toContain('X-WR-CALNAME:A maintenance');
    expect(body).toContain('X-WR-TIMEZONE:America/New_York');
  });

  it('includes a VTIMEZONE for every zone it references', async () => {
    const body = await (await fetchFeed(feedA)).text();
    expect(body).toContain('BEGIN:VTIMEZONE');
    expect(body).toContain('TZID:America/New_York');
  });

  it('keeps all-day events floating', async () => {
    // ADR-0005 survives the trip out: a DATE value, never a midnight
    // timestamp in some zone.
    const body = await (await fetchFeed(feedA)).text();
    expect(body).toContain('DTSTART;VALUE=DATE:20260704');
    expect(body).toContain('DTEND;VALUE=DATE:20260705');
  });

  it('uses CRLF line endings throughout', async () => {
    const body = await (await fetchFeed(feedA)).text();
    expect(body.split('\n').length - 1).toBe(body.split('\r\n').length - 1);
  });
});

describe.skipIf(!available)('a feed token is a credential', () => {
  it('grants exactly one calendar and nothing else', async () => {
    // The property that makes a leaked URL survivable.
    const body = await (await fetchFeed(feedA)).text();
    expect(body).toContain('Boiler inspection');
    expect(body).not.toContain('Tenant B private meeting');
  });

  it('cannot reach another tenant even though the endpoint is unauthenticated', async () => {
    const body = await (await fetchFeed(feedB)).text();
    expect(body).toContain('Tenant B private meeting');
    expect(body).not.toContain('Boiler inspection');
  });

  it('stops working the moment it is revoked', async () => {
    expect((await fetchFeed(revoked)).status).toBe(404);
  });

  it('revocation takes effect on the next poll, not at restart', async () => {
    const token = await createFeed(TENANT_A, calA, 'temporary');
    expect((await fetchFeed(token)).status).toBe(200);

    await harness.owner.query('UPDATE feed_tokens SET revoked_at = now() WHERE token_hash = $1', [
      hashFeedToken(token),
    ]);

    resetFeedRateLimits();
    expect((await fetchFeed(token)).status).toBe(404);
  });

  it('reports an unknown token as 404, never 403', async () => {
    // 403 would confirm the token had once existed.
    const { token } = mintFeedToken();
    const res = await fetchFeed(token);
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects a malformed token without touching the database', async () => {
    for (const bad of ['short', '../../etc/passwd', 'a'.repeat(200)]) {
      expect((await app.request(`/feeds/${encodeURIComponent(bad)}.ics`)).status).toBe(404);
    }
  });

  it('stores only a hash, so a database read yields no working URLs', async () => {
    const { rows } = await harness.owner.query<{ token_hash: string }>(
      'SELECT token_hash FROM feed_tokens LIMIT 5',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
      // The raw token appears nowhere.
      expect([feedA, feedB, revoked]).not.toContain(row.token_hash);
    }
  });
});

describe.skipIf(!available)('conditional requests', () => {
  it('returns 304 for a matching If-None-Match', async () => {
    const first = await fetchFeed(feedA);
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();

    const second = await fetchFeed(feedA, { 'If-None-Match': etag as string });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  it('returns 304 for a fresh If-Modified-Since', async () => {
    // Some clients send only this one.
    const first = await fetchFeed(feedA);
    const lastModified = first.headers.get('Last-Modified');
    expect(lastModified).toBeTruthy();

    const second = await fetchFeed(feedA, { 'If-Modified-Since': lastModified as string });
    expect(second.status).toBe(304);
  });

  it('serves the body when the validator does not match', async () => {
    const res = await fetchFeed(feedA, { 'If-None-Match': '"not-the-etag"' });
    expect(res.status).toBe(200);
  });

  it('produces a stable ETag for unchanged content', async () => {
    // DTSTAMP is derived from the event rather than the clock precisely so
    // that this holds; otherwise every poll is a full transfer.
    const a = await fetchFeed(feedA);
    const b = await fetchFeed(feedA);
    expect(a.headers.get('ETag')).toBe(b.headers.get('ETag'));
  });

  it('gives different feeds different ETags', async () => {
    const a = await fetchFeed(feedA);
    const b = await fetchFeed(feedB);
    expect(a.headers.get('ETag')).not.toBe(b.headers.get('ETag'));
  });
});

describe.skipIf(!available)('rate limiting', () => {
  it('refuses a token that polls far too hard, with Retry-After', async () => {
    // The only genuinely public surface in Gnomon, so one leaked URL must
    // not be an unbounded cost.
    resetFeedRateLimits();
    let last = await fetchFeed(feedA);
    for (let i = 0; i < 65 && last.status === 200; i += 1) last = await fetchFeed(feedA);

    expect(last.status).toBe(429);
    expect(Number(last.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('limits per token rather than globally', async () => {
    resetFeedRateLimits();
    for (let i = 0; i < 65; i += 1) await fetchFeed(feedA);

    // A different subscriber is unaffected by the noisy one.
    expect((await fetchFeed(feedB)).status).toBe(200);
  });
});

describe.skipIf(!available)('the feed parses back cleanly', () => {
  it('round-trips through an independent parser', async () => {
    // node-ical, not our serialiser -- a third-party parser reading our
    // output is the closest offline stand-in for the external validator the
    // exit criteria call for. It does not replace subscribing from Google,
    // Apple and Outlook by hand, which remains a manual step.
    const { parseCalendar } = await import('@gnomon/core/ics');
    const body = await (await fetchFeed(feedA)).text();

    const parsed = parseCalendar(body);
    expect(parsed.name).toBe('A maintenance');
    expect(parsed.events).toHaveLength(2);

    const weekly = parsed.events.find((e) => e.uid === 'weekly@a');
    // The RRULE survives as a rule, not as expanded instances.
    expect(weekly?.recurrence).toContain('FREQ=WEEKLY');
    expect(weekly?.timing).toEqual({
      kind: 'timed',
      start: '2026-03-01T09:00:00',
      end: '2026-03-01T10:00:00',
      timeZone: 'America/New_York',
    });

    const holiday = parsed.events.find((e) => e.uid === 'holiday@a');
    // Still floating after a full serialise/parse cycle.
    expect(holiday?.timing).toEqual({
      kind: 'allDay',
      startDate: '2026-07-04',
      endDate: '2026-07-05',
    });
  });

  it('folds long lines without corrupting them', async () => {
    const longTitle = `Quarterly ${'inspection '.repeat(12)}review`;
    await seedEvent(TENANT_A, calA, {
      uid: 'long@a',
      title: longTitle,
      timing: { kind: 'timed', start: '2026-03-03T09:00:00', end: '2026-03-03T10:00:00', timeZone: 'America/New_York' },
    });

    try {
      const body = await (await fetchFeed(feedA)).text();
      // It really is folded, or this proves nothing about unfolding.
      expect(body).toContain('\r\n ');

      const { parseCalendar } = await import('@gnomon/core/ics');
      expect(parseCalendar(body).events.find((e) => e.uid === 'long@a')?.title).toBe(longTitle);
    } finally {
      await harness.owner.query('DELETE FROM events WHERE uid = $1', ['long@a']);
    }
  });
});
