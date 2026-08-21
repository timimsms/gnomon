import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
  InvalidWindowError,
  MAX_WINDOW_DAYS,
  assertWindow,
  TooManyOccurrencesError,
  WindowTooLargeError,
  expandEvents,
} from '@gnomon/core';
import type { CalendarId, CalendarEvent } from '@gnomon/core';
import { requireToken, type AuthVariables } from '../auth/middleware.js';
import type { KeyRegistry, VerifyOptions } from '../auth/tokens.js';
import { permits } from '../auth/tokens.js';
import type { Database } from '../db/client.js';
import { fromEventRow, type EventRow } from '../db/events.js';
import { cors } from './cors.js';
import { registerEmbedRoutes } from './embed.js';
import { registerFeedRoutes } from './feeds.js';
import { TENANT_CACHE_HEADERS, computeETag, matchesIfNoneMatch } from './etag.js';
import {
  CalendarIdParamSchema,
  CalendarSchema,
  ErrorSchema,
  EventsQuerySchema,
  OccurrenceSchema,
} from './schemas.js';

/**
 * The read API (phase 3).
 *
 * A small phase by design: both hard parts -- correct expansion and enforced
 * tenancy -- already exist. This is the seam between them, and its main job is
 * to not get in their way.
 */

export interface AppOptions {
  db: Database;
  registry: KeyRegistry;
  verify?: VerifyOptions;
}

type Env = { Variables: AuthVariables };

export function createApp(options: AppOptions) {
  const app = new OpenAPIHono<Env>({
    // Zod rejections become the same error shape as everything else rather
    // than Hono's default, so a client has one thing to parse.
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: 'invalid_request', message: result.error.message }, 400);
      }
      return undefined;
    },
  });

  // First, and on everything: a preflight must be answered before auth runs,
  // or the browser never sends the real request and the 401 is invisible.
  app.use('*', cors());

  app.get('/health', (c) => c.json({ status: 'ok' }));

  // A stack trace in a response body is an information leak, and Hono's
  // default plain-text 500 gives a client a second error shape to parse.
  app.onError((error, c) => {
    console.error('[gnomon] unhandled error', error);
    return c.json({ error: 'internal_error' }, 500);
  });

  // Registered BEFORE the auth middleware: these serve the same public bytes
  // to everyone and carry no tenant data, and requiring a token to fetch the
  // loader would be a chicken-and-egg -- the loader is what obtains one.
  registerEmbedRoutes(app);

  // Also before the auth middleware: a feed's only credential is the opaque
  // token in its URL, because a calendar client cannot present a JWT.
  registerFeedRoutes(app, options.db);

  app.use('/calendars', requireToken(options.registry, options.verify ?? {}));
  app.use('/calendars/*', requireToken(options.registry, options.verify ?? {}));
  app.use('/events', requireToken(options.registry, options.verify ?? {}));

  registerListCalendars(app, options);
  registerGetCalendar(app, options);
  registerListEvents(app, options);

  app.doc('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Gnomon',
      version: '0.1.0',
      description:
        'An embeddable, multi-tenant calendar. Tokens are minted by the host portal ' +
        'and verified here; Gnomon has no accounts of its own (ADR-0004).',
    },
  });

  return app;
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

function registerListCalendars(app: OpenAPIHono<Env>, { db }: AppOptions) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/calendars',
      tags: ['calendars'],
      summary: 'List the calendars this token grants',
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: 'Calendars visible to the token',
          content: { 'application/json': { schema: z.object({ calendars: z.array(CalendarSchema) }) } },
        },
        304: { description: 'Unchanged since the supplied ETag' },
        401: { description: 'Missing or unacceptable token', content: { 'application/json': { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const token = c.get('token');

      const calendars = await db.withTenant(
        token.tenantId,
        async ({ client }) => {
          // RLS already restricts this to the tenant. The `cal` claim narrows
          // it further, to the calendars this particular user was granted --
          // a distinction RLS cannot make, since it knows tenants and not
          // subjects.
          const { rows } = await client.query<CalendarRow>(
            `SELECT id, name, time_zone, colour FROM calendars
              WHERE id = ANY($1::uuid[]) ORDER BY name`,
            [token.calendarIds],
          );
          return rows.map(toCalendar);
        },
        { readOnly: true },
      );

      return respond(c, token.tenantId, `calendars:${token.calendarIds.join(',')}`, { calendars });
    },
  );
}

function registerGetCalendar(app: OpenAPIHono<Env>, { db }: AppOptions) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/calendars/{id}',
      tags: ['calendars'],
      summary: 'Fetch one calendar',
      security: [{ bearerAuth: [] }],
      request: { params: CalendarIdParamSchema },
      responses: {
        200: { description: 'The calendar', content: { 'application/json': { schema: CalendarSchema } } },
        304: { description: 'Unchanged since the supplied ETag' },
        401: { description: 'Missing or unacceptable token', content: { 'application/json': { schema: ErrorSchema } } },
        404: { description: 'No such calendar, or not granted', content: { 'application/json': { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const token = c.get('token');
      const { id } = c.req.valid('param');

      // A calendar the token does not grant is reported as absent rather than
      // forbidden. 403 would confirm it exists, which is a membership oracle
      // across tenants.
      if (!permits(token, 'events:read', id as CalendarId)) {
        return c.json({ error: 'not_found' }, 404);
      }

      const calendar = await db.withTenant(
        token.tenantId,
        async ({ client }) => {
          const { rows } = await client.query<CalendarRow>(
            `SELECT id, name, time_zone, colour FROM calendars WHERE id = $1`,
            [id],
          );
          return rows[0] ? toCalendar(rows[0]) : null;
        },
        { readOnly: true },
      );

      if (!calendar) return c.json({ error: 'not_found' }, 404);
      return respond(c, token.tenantId, `calendar:${id}`, calendar);
    },
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function registerListEvents(app: OpenAPIHono<Env>, { db }: AppOptions) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/events',
      tags: ['events'],
      summary: 'Expand occurrences within a bounded window',
      description:
        'Returns occurrences, not stored rows: recurring events are expanded on read ' +
        `(ADR-0007). The window may not exceed ${MAX_WINDOW_DAYS} days.`,
      security: [{ bearerAuth: [] }],
      request: { query: EventsQuerySchema },
      responses: {
        200: {
          description: 'Expanded occurrences, ordered by start',
          content: { 'application/json': { schema: z.object({ occurrences: z.array(OccurrenceSchema) }) } },
        },
        304: { description: 'Unchanged since the supplied ETag' },
        400: { description: 'Window invalid or too wide', content: { 'application/json': { schema: ErrorSchema } } },
        401: { description: 'Missing or unacceptable token', content: { 'application/json': { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const token = c.get('token');
      const { from, to, tz, calendarId } = c.req.valid('query');

      const requested = calendarId
        ? calendarId.split(',').map((id) => id.trim()).filter(Boolean)
        : [...token.calendarIds];

      // Intersect with the grant rather than trusting the parameter. Asking
      // for a calendar the token does not carry yields nothing, not an error:
      // the same reasoning as the 404 above.
      const allowed = requested.filter((id) => permits(token, 'events:read', id as CalendarId));
      const renderTimeZone = tz ?? 'UTC';

      try {
        // Before the database, not after: an inverted or over-wide window
        // should be answered by us with a reason, not by Postgres refusing to
        // build a tstzrange. It also means a bad window costs no query.
        assertWindow({ from, to });

        const occurrences = await db.withTenant(
          token.tenantId,
          async ({ client }) => {
            if (allowed.length === 0) return [];

            // The GiST pre-filter (phase 2.2). Deliberately coarse: it never
            // excludes an event that could occur in the window, and exact
            // boundaries are applied by expandEvents below.
            const { rows } = await client.query<EventRow>(
              `SELECT id, tenant_id AS "tenantId", calendar_id AS "calendarId", uid, title,
                      description, location, status, timing_kind AS "timingKind",
                      start_local AS "startLocal", end_local AS "endLocal", time_zone AS "timeZone",
                      start_date AS "startDate", end_date AS "endDate", recurrence,
                      exception_dates AS "exceptionDates", sequence, search_span AS "searchSpan"
                 FROM events
                WHERE calendar_id = ANY($1::uuid[])
                  AND search_span && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
              [allowed, from, to],
            );

            // Expansion is @gnomon/core's job, start to finish. The API calls
            // it and serialises the result; any transformation belongs in
            // core, or the HTTP layer starts to disagree with the corpus.
            return expandEvents(rows.map(fromEventRow) as CalendarEvent[], { from, to }, {
              renderTimeZone,
            });
          },
          { readOnly: true },
        );

        return respond(
          c,
          token.tenantId,
          `events:${from}:${to}:${renderTimeZone}:${allowed.join(',')}`,
          { occurrences },
        );
      } catch (error) {
        return windowError(c, error);
      }
    },
  );
}

/**
 * Window failures are the client's to fix, so they say what the limit is.
 * A 500 here would be a lie -- nothing went wrong on our side -- and a bare
 * 400 makes the caller guess.
 */
function windowError(c: Context<Env>, error: unknown) {
  if (error instanceof WindowTooLargeError) {
    return c.json(
      { error: 'window_too_large', message: error.message, limit: MAX_WINDOW_DAYS },
      400,
    );
  }
  if (error instanceof InvalidWindowError) {
    return c.json({ error: 'invalid_window', message: error.message }, 400);
  }
  if (error instanceof TooManyOccurrencesError) {
    // Distinct from window_too_large on purpose: the remedies differ. A
    // caller can narrow a window; it cannot make a stored rule less dense.
    return c.json({ error: 'too_many_occurrences', message: error.message, limit: error.limit }, 400);
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

interface CalendarRow {
  id: string;
  name: string;
  time_zone: string;
  colour: string | null;
}

const toCalendar = (row: CalendarRow) => ({
  id: row.id,
  name: row.name,
  timeZone: row.time_zone,
  colour: row.colour,
});

/**
 * Serialises, attaches a tenant-scoped ETag, and answers 304 when the client
 * already has this exact body.
 */
function respond<T>(c: Context<Env>, tenantId: string, key: string, payload: T) {
  // Hashed over exactly what `c.json` will emit, so the validator can never
  // describe a body other than the one sent.
  const etag = computeETag({ tenantId, key, body: JSON.stringify(payload) });
  const headers = { ETag: etag, ...TENANT_CACHE_HEADERS };

  return matchesIfNoneMatch(c.req.header('If-None-Match'), etag)
    ? c.body(null, 304, headers)
    : c.json(payload, 200, headers);
}
