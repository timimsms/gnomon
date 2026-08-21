import { z } from '@hono/zod-openapi';
import type { CalendarEvent, CalendarId, EventId, TenantId } from '@gnomon/core';
import type { Context, Env, Hono } from 'hono';
import type { PoolClient } from 'pg';
import { permits, type VerifiedToken } from '../auth/tokens.js';
import type { Database } from '../db/client.js';
import { fromEventRow, toEventRow, type EventRow } from '../db/events.js';

/**
 * The write path (phase 6).
 *
 * NON-RECURRING EVENTS ONLY (L4). Recurrence editing -- "this / this and
 * following / all" -- is where calendar projects die, and shipping half of it
 * is worse than shipping none. Recurring events are read-only in v0.1, which
 * is a documented limitation rather than a bug.
 */

const TimedTimingSchema = z.object({
  kind: z.literal('timed'),
  start: z.string(),
  end: z.string(),
  timeZone: z.string(),
});

const AllDayTimingSchema = z.object({
  kind: z.literal('allDay'),
  startDate: z.string(),
  /** Exclusive, per RFC 5545 DTEND for DATE values (ADR-0005). */
  endDate: z.string(),
});

const TimingSchema = z.discriminatedUnion('kind', [TimedTimingSchema, AllDayTimingSchema]);

const CreateEventSchema = z.object({
  uid: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  location: z.string().optional(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
  timing: TimingSchema,
  /**
   * Accepted in the schema ONLY so it can be rejected with a specific
   * message. Omitting it would produce "unrecognised key", which reads as a
   * typo rather than as a deliberate limitation, and would be filed as a bug.
   */
  recurrence: z.string().optional(),
});

const UpdateEventSchema = CreateEventSchema.partial().omit({ uid: true });

const EVENT_COLUMNS = `id, tenant_id AS "tenantId", calendar_id AS "calendarId", uid, title,
  description, location, status, timing_kind AS "timingKind",
  start_local AS "startLocal", end_local AS "endLocal", time_zone AS "timeZone",
  start_date AS "startDate", end_date AS "endDate", recurrence,
  exception_dates AS "exceptionDates", sequence, search_span AS "searchSpan", version`;

export function registerWriteRoutes<E extends Env & { Variables: { token: VerifiedToken } }>(
  app: Hono<E>,
  db: Database,
): void {
  app.post('/calendars/:id/events', async (c) => {
    const token = c.get('token') as VerifiedToken;
    const calendarId = c.req.param('id') as CalendarId;

    const denied = denyWrite(c, token, calendarId);
    if (denied) return denied;

    const parsed = CreateEventSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', message: parsed.error.message }, 400);
    if (parsed.data.recurrence) return recurrenceUnsupported(c);

    try {
      const created = await db.withTenant(token.tenantId, async ({ client }) => {
        // Written with readOnly: false EXPLICITLY, so every mutating endpoint
        // is greppable and a read endpoint that grew a write is obvious.
        const event: CalendarEvent = {
          id: crypto.randomUUID() as EventId,
          tenantId: token.tenantId as TenantId,
          calendarId,
          uid: parsed.data.uid ?? `${crypto.randomUUID()}@gnomon`,
          title: parsed.data.title,
          timing: parsed.data.timing,
          ...(parsed.data.description ? { description: parsed.data.description } : {}),
          ...(parsed.data.location ? { location: parsed.data.location } : {}),
          ...(parsed.data.status ? { status: parsed.data.status } : {}),
        };

        const row = toEventRow(event);
        const { rows } = await client.query<EventRow & { version: number }>(
          `INSERT INTO events (id, tenant_id, calendar_id, uid, title, description, location,
             status, timing_kind, start_local, end_local, time_zone, start_date, end_date,
             search_span)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING ${EVENT_COLUMNS}`,
          [
            row.id, row.tenantId, row.calendarId, row.uid, row.title, row.description,
            row.location, row.status, row.timingKind, row.startLocal, row.endLocal,
            row.timeZone, row.startDate, row.endDate, row.searchSpan,
          ],
        );

        const stored = rows[0]!;
        await audit(client, token, 'create', stored, null, fromEventRow(stored));
        return stored;
      });

      return c.json(present(created), 201, { ETag: versionTag(created.version) });
    } catch (error) {
      return writeError(c, error);
    }
  });

  app.patch('/events/:id', async (c) => {
    const token = c.get('token') as VerifiedToken;
    const eventId = c.req.param('id');

    const parsed = UpdateEventSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request', message: parsed.error.message }, 400);
    if (parsed.data.recurrence) return recurrenceUnsupported(c);

    const ifMatch = c.req.header('If-Match');

    try {
      const result = await db.withTenant(token.tenantId, async ({ client }) => {
        // FOR UPDATE: without the lock, two writers can both read version 3,
        // both find If-Match satisfied, and both write version 4 -- which is
        // the lost update this endpoint exists to prevent.
        const existing = await client.query<EventRow & { version: number }>(
          `SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1 FOR UPDATE`,
          [eventId],
        );
        const current = existing.rows[0];
        if (!current) return { kind: 'not_found' as const };

        // Checked INSIDE the transaction, against the row we hold: the token
        // may grant the tenant but not this event's calendar, and RLS cannot
        // make that distinction because it knows tenants, not subjects.
        if (!permits(token, 'events:write', current.calendarId as CalendarId)) {
          return { kind: 'forbidden' as const };
        }
        if (current.recurrence) return { kind: 'recurring' as const };
        if (ifMatch && !matchesVersion(ifMatch, current.version)) {
          return { kind: 'conflict' as const, version: current.version };
        }

        const before = fromEventRow(current);
        const merged: CalendarEvent = {
          ...before,
          ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
          ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
          ...(parsed.data.location !== undefined ? { location: parsed.data.location } : {}),
          ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
          ...(parsed.data.timing !== undefined ? { timing: parsed.data.timing } : {}),
        };

        const row = toEventRow(merged);
        const { rows } = await client.query<EventRow & { version: number }>(
          `UPDATE events SET title = $2, description = $3, location = $4, status = $5,
             timing_kind = $6, start_local = $7, end_local = $8, time_zone = $9,
             start_date = $10, end_date = $11, search_span = $12,
             version = version + 1, updated_at = now()
           WHERE id = $1
           RETURNING ${EVENT_COLUMNS}`,
          [
            eventId, row.title, row.description, row.location, row.status, row.timingKind,
            row.startLocal, row.endLocal, row.timeZone, row.startDate, row.endDate, row.searchSpan,
          ],
        );

        const stored = rows[0]!;
        await audit(client, token, 'update', stored, before, fromEventRow(stored));
        return { kind: 'ok' as const, stored };
      });

      switch (result.kind) {
        case 'not_found':
          return c.json({ error: 'not_found' }, 404);
        case 'forbidden':
          return c.json({ error: 'forbidden', message: 'This token does not grant writes to that calendar.' }, 403);
        case 'recurring':
          return recurrenceUnsupported(c);
        case 'conflict':
          return c.json(
            {
              error: 'version_conflict',
              message: 'The event changed since you read it. Re-read it and retry.',
            },
            409,
            { ETag: versionTag(result.version) },
          );
        default:
          return c.json(present(result.stored), 200, { ETag: versionTag(result.stored.version) });
      }
    } catch (error) {
      return writeError(c, error);
    }
  });

  app.delete('/events/:id', async (c) => {
    const token = c.get('token') as VerifiedToken;
    const eventId = c.req.param('id');
    const ifMatch = c.req.header('If-Match');

    try {
      const result = await db.withTenant(token.tenantId, async ({ client }) => {
        const existing = await client.query<EventRow & { version: number }>(
          `SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1 FOR UPDATE`,
          [eventId],
        );
        const current = existing.rows[0];
        if (!current) return { kind: 'not_found' as const };
        if (!permits(token, 'events:write', current.calendarId as CalendarId)) {
          return { kind: 'forbidden' as const };
        }
        if (current.recurrence) return { kind: 'recurring' as const };
        if (ifMatch && !matchesVersion(ifMatch, current.version)) {
          return { kind: 'conflict' as const, version: current.version };
        }

        // Audited BEFORE the delete: afterwards there is nothing left to
        // record, and an audit log that omits deletions is worse than none.
        await audit(client, token, 'delete', current, fromEventRow(current), null);
        await client.query('DELETE FROM events WHERE id = $1', [eventId]);
        return { kind: 'ok' as const };
      });

      switch (result.kind) {
        case 'not_found':
          return c.json({ error: 'not_found' }, 404);
        case 'forbidden':
          return c.json({ error: 'forbidden' }, 403);
        case 'recurring':
          return recurrenceUnsupported(c);
        case 'conflict':
          return c.json({ error: 'version_conflict' }, 409, { ETag: versionTag(result.version) });
        default:
          return c.body(null, 204);
      }
    } catch (error) {
      return writeError(c, error);
    }
  });
}

/**
 * Refuses a write the token does not carry.
 *
 * Two separate checks, and the second is the one RLS cannot make: RLS
 * enforces the TENANT boundary, but a token scoped to calendar A must not
 * write to calendar B within the same tenant, and the database has no idea
 * which calendars a subject was granted.
 */
function denyWrite(c: Context, token: VerifiedToken, calendarId: CalendarId): Response | null {
  if (!token.scopes.includes('events:write')) {
    return c.json(
      { error: 'insufficient_scope', message: 'This token does not carry events:write.' },
      403,
      { 'WWW-Authenticate': 'Bearer scope="events:write"' },
    );
  }
  if (!permits(token, 'events:write', calendarId)) {
    return c.json(
      { error: 'forbidden', message: 'This token does not grant writes to that calendar.' },
      403,
    );
  }
  return null;
}

/**
 * The refusal must be SPECIFIC (L4).
 *
 * A generic validation error here reads as a bug and will be filed as one.
 * This says what is unsupported, that it is deliberate, and where to read
 * about it.
 */
function recurrenceUnsupported(c: Context): Response {
  return c.json(
    {
      error: 'recurrence_not_editable',
      message:
        'Recurring events are read-only in this version. Creating or modifying a recurrence ' +
        'rule is not supported; see the documented limitations (L4).',
    },
    422,
  );
}

function writeError(c: Context, error: unknown): Response {
  const code = (error as { code?: string } | null)?.code;

  // 23505 unique_violation: the calendar/uid pair is taken. That is the
  // caller's to resolve, not a server fault.
  if (code === '23505') {
    return c.json({ error: 'duplicate_uid', message: 'An event with that uid already exists on this calendar.' }, 409);
  }
  // 23514 check_violation: the timing union's CHECK constraints rejected it.
  if (code === '23514') {
    return c.json({ error: 'invalid_timing', message: 'The event timing is not a valid shape.' }, 400);
  }
  // 23503 foreign_key_violation: no such calendar in this tenant. Reported as
  // not_found rather than a 500 -- it is a bad reference, not a broken server.
  if (code === '23503') {
    return c.json({ error: 'not_found', message: 'No such calendar.' }, 404);
  }
  throw error;
}

/**
 * Records a mutation.
 *
 * `subject` is the opaque `sub` from the token, so this log only becomes
 * meaningful joined against the host's own records (ADR-0004). Integrators
 * have to be told to keep that mapping -- they will want it eventually, and
 * by then it is too late to start.
 *
 * Append-only is enforced by GRANT, not by this function: the application
 * role has SELECT and INSERT on audit_log and nothing else, so a compromised
 * application cannot rewrite its own history no matter what the code says.
 */
async function audit(
  client: PoolClient,
  token: VerifiedToken,
  operation: 'create' | 'update' | 'delete',
  row: EventRow,
  before: CalendarEvent | null,
  after: CalendarEvent | null,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (tenant_id, subject, calendar_id, event_id, operation, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      token.tenantId,
      token.subject,
      row.calendarId,
      row.id,
      operation,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
    ],
  );
}

/** Strong validator over the row version. */
function versionTag(version: number): string {
  return `"v${version}"`;
}

function matchesVersion(ifMatch: string, version: number): boolean {
  const tag = versionTag(version);
  return ifMatch
    .split(',')
    .some((candidate) => {
      const value = candidate.trim().replace(/^W\//, '');
      return value === '*' || value === tag;
    });
}

function present(row: EventRow & { version: number }) {
  return { ...fromEventRow(row), version: row.version };
}
