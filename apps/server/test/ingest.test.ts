import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportSPKI, generateKeyPair } from 'jose';
import type { TenantId } from '@gnomon/core';
import { InMemoryKeyRegistry, registerSpkiKey } from '../src/auth/registry.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { createApp } from '../src/http/app.js';
import { backoffSeconds, fingerprint, reconcile } from '../src/ingest/reconcile.js';
import { pollKnownSource } from '../src/ingest/poll.js';
import type { FetchResult } from '../src/ingest/fetch.js';
import {
  NO_DATABASE_MESSAGE,
  createTestDatabase,
  findAdminUrl,
  type TestDatabase,
} from './support/database.js';

/**
 * ICS ingest (phase 7.2).
 *
 * The reconciliation half is pure and gets tested exhaustively, because the
 * diff is where the data-loss bugs live. The polling half runs against a real
 * database with an injected fetch, since what matters there is what ends up
 * in the tables.
 */

const ICS = (events: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n${events}END:VCALENDAR\r\n`;

const VEVENT = (uid: string, summary: string, start = '20260601T090000') =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20260101T000000Z\r\n` +
  `DTSTART;TZID=America/New_York:${start}\r\n` +
  `DTEND;TZID=America/New_York:20260601T100000\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\n`;

const event = (uid: string, title: string, extra: Record<string, unknown> = {}) => ({
  uid,
  title,
  timing: {
    kind: 'timed' as const,
    start: '2026-06-01T09:00:00',
    end: '2026-06-01T10:00:00',
    timeZone: 'America/New_York',
  },
  ...extra,
});

describe('reconciling a feed against what we stored', () => {
  const stored = (id: string, uid: string, title: string) => ({
    id,
    uid,
    fingerprint: fingerprint(event(uid, title)),
  });

  it('creates events the feed has and we do not', () => {
    const plan = reconcile({ incoming: [event('a@x', 'A')], existing: [] });
    expect(plan.create).toHaveLength(1);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it('matches on uid, not on our primary key', () => {
    // The remote feed knows nothing about our ids. This is why phase 1 kept
    // `uid` distinct from `id`.
    const plan = reconcile({
      incoming: [event('a@x', 'A renamed')],
      existing: [stored('our-own-uuid', 'a@x', 'A')],
    });

    expect(plan.create).toEqual([]);
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0]?.id).toBe('our-own-uuid');
  });

  it('leaves unchanged events alone', () => {
    const plan = reconcile({
      incoming: [event('a@x', 'A')],
      existing: [stored('id-1', 'a@x', 'A')],
    });

    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('removes events the feed has dropped', () => {
    const plan = reconcile({ incoming: [], existing: [stored('id-1', 'gone@x', 'Gone')] });
    expect(plan.remove).toEqual(['id-1']);
  });

  it('ignores a repeated uid deterministically', () => {
    // A feed repeating a UID is malformed. Taking the first keeps the poll
    // deterministic; taking the last would make the result depend on parse
    // order.
    const plan = reconcile({
      incoming: [event('dup@x', 'First'), event('dup@x', 'Second')],
      existing: [],
    });

    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]?.title).toBe('First');
  });

  it('does not treat reordered EXDATEs as a change', () => {
    // A feed serialising its exceptions in a different order has not changed
    // the event, and reporting it as an update every poll would make the
    // "unchanged" count useless.
    const a = event('a@x', 'A', { exceptionDates: ['2026-06-08T13:00:00Z', '2026-06-15T13:00:00Z'] });
    const b = event('a@x', 'A', { exceptionDates: ['2026-06-15T13:00:00Z', '2026-06-08T13:00:00Z'] });
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('notices a timing change', () => {
    const moved = event('a@x', 'A');
    moved.timing = { ...moved.timing, start: '2026-06-01T11:00:00' };
    expect(fingerprint(moved)).not.toBe(fingerprint(event('a@x', 'A')));
  });

  it('notices a timezone change even when the wall clock is identical', () => {
    // 09:00 New York and 09:00 Tokyo are different moments, and a feed that
    // corrects its timezone has genuinely changed the event.
    const tokyo = event('a@x', 'A');
    tokyo.timing = { ...tokyo.timing, timeZone: 'Asia/Tokyo' };
    expect(fingerprint(tokyo)).not.toBe(fingerprint(event('a@x', 'A')));
  });
});

describe('backoff', () => {
  it('does not wait at all when nothing has failed', () => {
    expect(backoffSeconds(0)).toBe(0);
  });

  it('grows exponentially', () => {
    expect(backoffSeconds(1)).toBe(300);
    expect(backoffSeconds(2)).toBe(600);
    expect(backoffSeconds(3)).toBe(1200);
  });

  it('stops growing at a ceiling, so a recovered source is noticed', () => {
    // Without a ceiling, a source broken for a week would not be retried for
    // another week after it was fixed.
    expect(backoffSeconds(50)).toBe(6 * 60 * 60);
    expect(backoffSeconds(1000)).toBe(6 * 60 * 60);
  });
});

// ---------------------------------------------------------------------------
// Against a real database
// ---------------------------------------------------------------------------

const adminUrl = await findAdminUrl();
const available = adminUrl !== null;
if (!available && !process.env.CI) console.warn(`\n${NO_DATABASE_MESSAGE}\n`);

const TENANT = 'tenant-a' as TenantId;
let harness: TestDatabase;
let db: Database;
let app: ReturnType<typeof createApp>;
let calendarId: string;
let sourceId: string;
let signing: CryptoKeyPair;

beforeAll(async () => {
  if (!available) return;
  harness = await createTestDatabase(adminUrl as string);

  const registry = new InMemoryKeyRegistry();
  signing = (await generateKeyPair('Ed25519', { extractable: true })) as CryptoKeyPair;
  await registerSpkiKey(registry, {
    kid: 'key-a',
    tenantId: TENANT,
    spki: await exportSPKI(signing.publicKey),
  });

  await harness.owner.query(`INSERT INTO tenants (id, name) VALUES ($1,$1)`, [TENANT]);
  calendarId = (
    await harness.owner.query<{ id: string }>(
      `INSERT INTO calendars (tenant_id, name, time_zone)
       VALUES ($1,'Synced','America/New_York') RETURNING id`,
      [TENANT],
    )
  ).rows[0]!.id;

  sourceId = (
    await harness.owner.query<{ id: string }>(
      `INSERT INTO ics_sources (tenant_id, calendar_id, url)
       VALUES ($1,$2,'https://feed.example.test/cal.ics') RETURNING id`,
      [TENANT, calendarId],
    )
  ).rows[0]!.id;

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

function source() {
  return {
    id: sourceId,
    tenant_id: TENANT,
    calendar_id: calendarId,
    url: 'https://feed.example.test/cal.ics',
    etag: null as string | null,
    last_modified: null as string | null,
    consecutive_failures: 0,
  };
}

const respond = (body: string, extra: Partial<FetchResult> = {}): Promise<FetchResult> =>
  Promise.resolve({ status: 200, body, ...extra });

const storedEvents = async () =>
  (
    await harness.owner.query<{ uid: string; title: string; ics_source_id: string | null }>(
      `SELECT uid, title, ics_source_id FROM events WHERE calendar_id = $1 ORDER BY uid`,
      [calendarId],
    )
  ).rows;

describe.skipIf(!available)('polling a source', () => {
  it('creates events on the first poll and records the validators', async () => {
    const outcome = await pollKnownSource(source(), { db }, () =>
      respond(ICS(VEVENT('a@feed', 'Boiler inspection') + VEVENT('b@feed', 'Fire alarm')), {
        etag: '"v1"',
      }),
    );

    expect(outcome).toMatchObject({ status: 'applied', created: 2, updated: 0, removed: 0 });
    expect((await storedEvents()).map((e) => e.title)).toEqual(['Boiler inspection', 'Fire alarm']);

    const { rows } = await harness.owner.query<{ etag: string; consecutive_failures: number }>(
      'SELECT etag, consecutive_failures FROM ics_sources WHERE id = $1',
      [sourceId],
    );
    expect(rows[0]?.etag).toBe('"v1"');
    expect(rows[0]?.consecutive_failures).toBe(0);
  });

  it('sends the stored validators and does nothing on 304', async () => {
    let sentEtag: string | undefined;
    const outcome = await pollKnownSource({ ...source(), etag: '"v1"' }, { db }, (_url, options) => {
      sentEtag = options.etag;
      return Promise.resolve({ status: 304 });
    });

    expect(sentEtag).toBe('"v1"');
    expect(outcome.status).toBe('unchanged');
    // Most polls should cost a 304 and nothing else.
    expect(await storedEvents()).toHaveLength(2);
  });

  it('applies additions, changes and removals in one poll', async () => {
    const outcome = await pollKnownSource(source(), { db }, () =>
      // b@feed is gone, a@feed is renamed, c@feed is new.
      respond(ICS(VEVENT('a@feed', 'Boiler inspection (rescheduled)') + VEVENT('c@feed', 'New'))),
    );

    expect(outcome).toMatchObject({ status: 'applied', created: 1, updated: 1, removed: 1 });
    expect((await storedEvents()).map((e) => e.uid)).toEqual(['a@feed', 'c@feed']);
  });

  it('does not touch events created by hand on the same calendar', async () => {
    // Scoping the diff by calendar rather than by source would delete these.
    await harness.owner.query(
      `INSERT INTO events (tenant_id, calendar_id, uid, title, timing_kind, start_local,
         end_local, time_zone, search_span)
       VALUES ($1,$2,'manual@local','Created by hand','timed','2026-06-02T09:00:00',
         '2026-06-02T10:00:00','America/New_York','[2026-06-02T13:00:00Z,2026-06-02T14:00:00Z)')`,
      [TENANT, calendarId],
    );

    // Feeds back exactly what the source already has, so a correctly-scoped
    // diff removes NOTHING. Dropping one of the source's own events here
    // would make `removed: 1` correct and the assertion useless.
    const outcome = await pollKnownSource(source(), { db }, () =>
      respond(ICS(VEVENT('a@feed', 'Boiler inspection (rescheduled)') + VEVENT('c@feed', 'New'))),
    );

    const uids = (await storedEvents()).map((e) => e.uid);
    expect(uids).toContain('manual@local');
    expect(uids).toContain('a@feed');
    expect(uids).toContain('c@feed');

    // The COUNT matters as much as the survival. There are two guards here:
    // the diff is scoped to this source, AND the DELETE re-checks
    // ics_source_id. Asserting only that manual@local survives passes even
    // when the diff is wrongly scoped by calendar, because the second guard
    // catches it -- so that assertion proves defence in depth, not scoping.
    // A wrongly-scoped diff would plan to remove manual@local and say so.
    expect(outcome).toMatchObject({ status: 'applied', removed: 0 });
  });

  it('marks ingested events with their source', async () => {
    const ingested = (await storedEvents()).find((e) => e.uid === 'a@feed');
    expect(ingested?.ics_source_id).toBe(sourceId);

    const manual = (await storedEvents()).find((e) => e.uid === 'manual@local');
    expect(manual?.ics_source_id).toBeNull();
  });

  it('refuses to treat an empty body as "delete everything"', async () => {
    // An empty or truncated response is far likelier to be a broken source
    // than a genuinely emptied calendar, and the destructive reading is
    // unrecoverable.
    const before = await storedEvents();
    const outcome = await pollKnownSource(source(), { db }, () => respond(''));

    expect(outcome.status).toBe('failed');
    expect(await storedEvents()).toHaveLength(before.length);
  });

  it('records a failure with a retry delay rather than throwing', async () => {
    const outcome = await pollKnownSource(source(), { db }, () =>
      Promise.reject(new Error('connect ETIMEDOUT')),
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.retryAfter).toBeGreaterThan(0);

    const { rows } = await harness.owner.query<{ last_error: string; consecutive_failures: number }>(
      'SELECT last_error, consecutive_failures FROM ics_sources WHERE id = $1',
      [sourceId],
    );
    // Surfaced in operator-facing state, not only in a log.
    expect(rows[0]?.last_error).toContain('ETIMEDOUT');
    expect(rows[0]?.consecutive_failures).toBeGreaterThan(0);
  });

  it('clears the failure state once a poll succeeds', async () => {
    await pollKnownSource(source(), { db }, () => respond(ICS(VEVENT('a@feed', 'Recovered'))));

    const { rows } = await harness.owner.query<{ last_error: string | null; consecutive_failures: number }>(
      'SELECT last_error, consecutive_failures FROM ics_sources WHERE id = $1',
      [sourceId],
    );
    expect(rows[0]?.last_error).toBeNull();
    expect(rows[0]?.consecutive_failures).toBe(0);
  });
});

describe.skipIf(!available)('ingested events are read-only to the write path', () => {
  const mint = async () =>
    new SignJWT({ cal: [calendarId], scp: ['events:read', 'events:write'], tid: TENANT, sub: 'r' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'key-a' })
      .setAudience('gnomon')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signing.privateKey);

  const ingestedId = async () =>
    (
      await harness.owner.query<{ id: string }>(
        `SELECT id FROM events WHERE ics_source_id = $1 LIMIT 1`,
        [sourceId],
      )
    ).rows[0]!.id;

  it('refuses a PATCH with a specific, documented reason', async () => {
    // Accepting it would be a silent lie: the next poll reverts the change.
    const res = await app.request(`/events/${await ingestedId()}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await mint()}` },
      body: JSON.stringify({ title: 'Edited by hand' }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('event_is_ingested');
    expect(body.message).toMatch(/reverted by the next poll/i);
  });

  it('refuses a DELETE the same way', async () => {
    const res = await app.request(`/events/${await ingestedId()}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await mint()}` },
    });
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe('event_is_ingested');
  });

  it('still allows editing a hand-created event on the same calendar', async () => {
    const { rows } = await harness.owner.query<{ id: string }>(
      `SELECT id FROM events WHERE uid = 'manual@local'`,
    );
    const res = await app.request(`/events/${rows[0]!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await mint()}` },
      body: JSON.stringify({ title: 'Edited freely' }),
    });
    expect(res.status).toBe(200);
  });
});
