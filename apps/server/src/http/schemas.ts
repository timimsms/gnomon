import { z } from '@hono/zod-openapi';
import { MAX_WINDOW_DAYS } from '@gnomon/core';

/**
 * The API contract, as Zod.
 *
 * One definition, two consumers: request validation at runtime and the
 * OpenAPI document (3.4). A hand-maintained spec is wrong within a month, so
 * there isn't one.
 */

export const CalendarSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    timeZone: z.string().openapi({ example: 'America/New_York' }),
    colour: z.string().nullable(),
  })
  .openapi('Calendar');

const TimedTiming = z
  .object({
    kind: z.literal('timed'),
    start: z.string().openapi({ example: '2026-03-08T09:00:00' }),
    end: z.string().openapi({ example: '2026-03-08T10:00:00' }),
    timeZone: z.string().openapi({ example: 'America/New_York' }),
  })
  .openapi('TimedTiming');

const AllDayTiming = z
  .object({
    kind: z.literal('allDay'),
    startDate: z.string().openapi({ example: '2026-10-03' }),
    /** Exclusive, per RFC 5545 DTEND for DATE values (ADR-0005). */
    endDate: z.string().openapi({ example: '2026-10-04' }),
  })
  .openapi('AllDayTiming');

/**
 * A discriminated union on the wire too, not a boolean plus optional fields.
 * The client has the same reason to want invalid states unrepresentable that
 * the server did (ADR-0005).
 */
export const EventTimingSchema = z
  .discriminatedUnion('kind', [TimedTiming, AllDayTiming])
  .openapi('EventTiming');

export const OccurrenceSchema = z
  .object({
    eventId: z.string(),
    calendarId: z.string(),
    /** Absent for non-recurring events. Identifies WHICH instance this is. */
    recurrenceId: z.string().optional(),
    title: z.string(),
    description: z.string().optional(),
    location: z.string().optional(),
    status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
    timing: EventTimingSchema,
    isOverride: z.boolean(),
  })
  .openapi('EventOccurrence');

export const ErrorSchema = z
  .object({
    error: z.string(),
    message: z.string().optional(),
    /** Present on window errors, so a client can adjust without guessing. */
    limit: z.number().optional(),
  })
  .openapi('Error');

/**
 * `from`/`to` bound the expansion; `tz` is the zone occurrences are RENDERED
 * in, which is not the zone a rule is ANCHORED to. Phase 1's cross-timezone
 * fixtures cover the distinction and the API must preserve it.
 */
export const EventsQuerySchema = z.object({
  from: z.string().openapi({
    param: { name: 'from', in: 'query' },
    example: '2026-03-01T00:00:00Z',
    description: 'Inclusive start of the expansion window, as an ISO 8601 instant.',
  }),
  to: z.string().openapi({
    param: { name: 'to', in: 'query' },
    example: '2026-04-01T00:00:00Z',
    description: `Exclusive end. The window may not exceed ${MAX_WINDOW_DAYS} days.`,
  }),
  tz: z
    .string()
    .optional()
    .openapi({
      param: { name: 'tz', in: 'query' },
      example: 'America/New_York',
      description:
        'IANA zone the occurrences are rendered in. Determines which side of a ' +
        'date boundary an all-day event falls on. Not the zone a recurrence is anchored to.',
    }),
  calendarId: z
    .string()
    .optional()
    .openapi({
      param: { name: 'calendarId', in: 'query' },
      description:
        'Comma-separated calendar ids. Defaults to every calendar the token grants.',
    }),
});

export const CalendarIdParamSchema = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'cal-maintenance' }),
});
