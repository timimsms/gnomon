import { parseCalendar } from '@gnomon/core/ics';
import type { CalendarEvent, CalendarId, EventId, TenantId } from '@gnomon/core';
import type { PoolClient } from 'pg';
import type { Database } from '../db/client.js';
import { toEventRow } from '../db/events.js';
import { FetchFailedError, fetchIcs, type FetchOptions, type FetchResult } from './fetch.js';
import { UrlRejectedError } from './ssrf.js';
import { backoffSeconds, fingerprint, reconcile, type IncomingEvent, type StoredEvent } from './reconcile.js';

/**
 * Polling one ICS source (phase 7.2).
 *
 * Fetch conditionally, parse, diff, apply, record what happened. The fetching
 * is already hardened (`fetch.ts`) and the diff is already pure
 * (`reconcile.ts`); this is the part that touches the database.
 */

export interface PollOutcome {
  status: 'unchanged' | 'applied' | 'failed';
  created?: number;
  updated?: number;
  removed?: number;
  unchanged?: number;
  error?: string;
  /** Seconds to wait before the next attempt, when failing. */
  retryAfter?: number;
}

export interface PollDeps {
  db: Database;
  /** Injectable so the poller can be tested without a network. */
  fetch?: (url: string, options: FetchOptions) => Promise<FetchResult>;
}

interface SourceRow {
  id: string;
  tenant_id: string;
  calendar_id: string;
  url: string;
  etag: string | null;
  last_modified: string | null;
  consecutive_failures: number;
}

export async function pollSource(sourceId: string, deps: PollDeps): Promise<PollOutcome> {
  const doFetch = deps.fetch ?? fetchIcs;

  // Read outside a tenant context is impossible -- ics_sources is under RLS.
  // The scheduler supplies the tenant alongside the id, so this reads it back
  // with the context already set.
  const source = await deps.db.withTenant(
    '',
    async ({ client }) => {
      const { rows } = await client.query<SourceRow>(
        // The job payload carries the tenant, so this lookup is scoped by the
        // SECURITY DEFINER-free path: the caller sets the context below.
        `SELECT id, tenant_id, calendar_id, url, etag, last_modified, consecutive_failures
           FROM ics_sources WHERE id = $1`,
        [sourceId],
      );
      return rows[0] ?? null;
    },
    { readOnly: true },
  );

  if (!source) return { status: 'failed', error: 'source not found' };

  return pollKnownSource(source, deps, doFetch);
}

/**
 * Polls a source whose row has already been read.
 *
 * Split out so the scheduler can hand over the row it already has rather than
 * re-reading it, and so tests can drive it directly.
 */
export async function pollKnownSource(
  source: SourceRow,
  deps: PollDeps,
  doFetch: (url: string, options: FetchOptions) => Promise<FetchResult> = fetchIcs,
): Promise<PollOutcome> {
  let result: FetchResult;

  try {
    result = await doFetch(source.url, {
      // Conditional by default. Polling an unchanged feed unconditionally is
      // rude to the source and pointless for us -- most polls should cost a
      // 304 and nothing else.
      ...(source.etag ? { etag: source.etag } : {}),
      ...(source.last_modified ? { lastModified: source.last_modified } : {}),
    });
  } catch (error) {
    return recordFailure(source, deps.db, describeFailure(error));
  }

  if (result.status === 304) {
    await deps.db.withTenant(source.tenant_id, async ({ client }) => {
      await client.query(
        `UPDATE ics_sources
            SET last_success_at = now(), consecutive_failures = 0, last_error = NULL
          WHERE id = $1`,
        [source.id],
      );
    });
    return { status: 'unchanged' };
  }

  let incoming: IncomingEvent[];
  try {
    // A feed that parses to nothing is treated as a failure rather than as
    // "delete everything". An empty or truncated response is far more likely
    // to be a broken source than a genuinely emptied calendar, and the
    // destructive reading is unrecoverable.
    const parsed = parseCalendar(result.body ?? '');
    if (parsed.events.length === 0 && (result.body ?? '').trim() === '') {
      return recordFailure(source, deps.db, 'source returned an empty body');
    }
    incoming = parsed.events;
  } catch (error) {
    return recordFailure(source, deps.db, `could not parse: ${message(error)}`);
  }

  try {
    return await applyPlan(source, incoming, result, deps.db);
  } catch (error) {
    return recordFailure(source, deps.db, `could not apply: ${message(error)}`);
  }
}

async function applyPlan(
  source: SourceRow,
  incoming: IncomingEvent[],
  result: FetchResult,
  db: Database,
): Promise<PollOutcome> {
  return db.withTenant(source.tenant_id, async ({ client }) => {
    const existing = await client.query<StoredEvent & { uid: string }>(
      // Scoped to THIS source. Scoping by calendar instead would delete
      // hand-created events the moment a feed stopped mentioning them.
      `SELECT id, uid, fingerprint FROM events WHERE ics_source_id = $1`,
      [source.id],
    );

    const plan = reconcile({ incoming, existing: existing.rows });

    for (const event of plan.create) {
      await insertEvent(client, source, event);
    }
    for (const { id, event } of plan.update) {
      await updateEvent(client, id, event);
    }
    if (plan.remove.length > 0) {
      await client.query(`DELETE FROM events WHERE id = ANY($1::uuid[]) AND ics_source_id = $2`, [
        plan.remove,
        source.id,
      ]);
    }

    await client.query(
      `UPDATE ics_sources
          SET etag = $2, last_modified = $3, last_success_at = now(),
              consecutive_failures = 0, last_error = NULL
        WHERE id = $1`,
      [source.id, result.etag ?? null, result.lastModified ?? null],
    );

    return {
      status: 'applied' as const,
      created: plan.create.length,
      updated: plan.update.length,
      removed: plan.remove.length,
      unchanged: plan.unchanged,
    };
  });
}

async function insertEvent(client: PoolClient, source: SourceRow, event: IncomingEvent) {
  const row = toEventRow({
    ...event,
    id: crypto.randomUUID() as EventId,
    tenantId: source.tenant_id as TenantId,
    calendarId: source.calendar_id as CalendarId,
  } as CalendarEvent);

  await client.query(
    `INSERT INTO events (id, tenant_id, calendar_id, ics_source_id, uid, title, description,
       location, status, timing_kind, start_local, end_local, time_zone, start_date, end_date,
       recurrence, exception_dates, sequence, search_span, fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (calendar_id, uid) DO NOTHING`,
    [
      row.id, row.tenantId, row.calendarId, source.id, row.uid, row.title, row.description,
      row.location, row.status, row.timingKind, row.startLocal, row.endLocal, row.timeZone,
      row.startDate, row.endDate, row.recurrence, row.exceptionDates, row.sequence,
      row.searchSpan, fingerprint(event),
    ],
  );
}

async function updateEvent(client: PoolClient, id: string, event: IncomingEvent) {
  const row = toEventRow({
    ...event,
    id: id as EventId,
    tenantId: '' as TenantId,
    calendarId: '' as CalendarId,
  } as CalendarEvent);

  await client.query(
    `UPDATE events SET title = $2, description = $3, location = $4, status = $5,
       timing_kind = $6, start_local = $7, end_local = $8, time_zone = $9,
       start_date = $10, end_date = $11, recurrence = $12, exception_dates = $13,
       sequence = $14, search_span = $15, fingerprint = $16,
       version = version + 1, updated_at = now()
     WHERE id = $1`,
    [
      id, row.title, row.description, row.location, row.status, row.timingKind,
      row.startLocal, row.endLocal, row.timeZone, row.startDate, row.endDate,
      row.recurrence, row.exceptionDates, row.sequence, row.searchSpan, fingerprint(event),
    ],
  );
}

/**
 * Records a failure and says when to try again.
 *
 * The error is stored in operator-facing state rather than only logged: a
 * source that has been failing for a week should be visible as broken, not
 * discoverable by grepping logs.
 */
async function recordFailure(source: SourceRow, db: Database, error: string): Promise<PollOutcome> {
  const failures = source.consecutive_failures + 1;

  await db.withTenant(source.tenant_id, async ({ client }) => {
    await client.query(
      `UPDATE ics_sources
          SET last_error = $2, last_error_at = now(), consecutive_failures = $3
        WHERE id = $1`,
      [source.id, error.slice(0, 500), failures],
    );
  });

  return { status: 'failed', error, retryAfter: backoffSeconds(failures) };
}

/**
 * A refused URL is reported distinctly from a network failure.
 *
 * "This source points somewhere we will not fetch from" is an operator's
 * problem to fix; "the source timed out" is the source's. Collapsing them
 * into one message makes the first look transient when it never is.
 */
function describeFailure(error: unknown): string {
  if (error instanceof UrlRejectedError) return `refused: ${error.reason} (${error.message})`;
  if (error instanceof FetchFailedError) return `${error.kind}: ${error.message}`;
  return message(error);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
