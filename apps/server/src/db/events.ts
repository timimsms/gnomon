import { Temporal } from '@gnomon/core';
import type { CalendarEvent, CalendarId, EventId, EventTiming, TenantId } from '@gnomon/core';

/**
 * Domain <-> row mapping for events.
 *
 * The interesting part is `searchSpan`. Everything else is field shuffling.
 */

export interface EventRow {
  id: string;
  tenantId: string;
  calendarId: string;
  uid: string;
  title: string;
  description: string | null;
  location: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled' | null;
  timingKind: 'timed' | 'allDay';
  startLocal: string | null;
  endLocal: string | null;
  timeZone: string | null;
  startDate: string | null;
  endDate: string | null;
  recurrence: string | null;
  exceptionDates: string[] | null;
  sequence: number | null;
  searchSpan: string;
}

/**
 * The widest UTC offset any IANA zone uses is +14:00 (Pacific/Kiritimati);
 * the narrowest is -12:00. Padding an all-day span by 14 hours on BOTH sides
 * therefore covers every zone a caller could render in, with room to spare on
 * the negative side.
 *
 * This is what lets an all-day span avoid depending on the calendar's
 * timezone at all. Anchoring it to the calendar zone would have been tighter
 * and would have meant that correcting a misconfigured `calendars.time_zone`
 * silently invalidated every stored span -- the exact class of problem
 * ADR-0005 rejected zone-anchored storage to avoid. A fixed pad has no such
 * coupling, and 14 hours of slack on a date-granular query is free.
 */
const ALL_DAY_PAD_HOURS = 14;

/**
 * Slack added past a recurrence's UNTIL.
 *
 * UNTIL bounds the last occurrence's START. The occurrence still has a
 * duration, that duration is nominal wall-clock and so varies by an hour
 * across a DST boundary, and UNTIL may be date-valued rather than an instant.
 * A day of slack absorbs all three rather than reasoning about each.
 */
const UNTIL_SLACK_HOURS = 24;

export function toEventRow(event: CalendarEvent): EventRow {
  const timing = event.timing;

  return {
    id: event.id,
    tenantId: event.tenantId,
    calendarId: event.calendarId,
    uid: event.uid,
    title: event.title,
    description: event.description ?? null,
    location: event.location ?? null,
    status: event.status ?? null,
    timingKind: timing.kind,
    startLocal: timing.kind === 'timed' ? timing.start : null,
    endLocal: timing.kind === 'timed' ? timing.end : null,
    timeZone: timing.kind === 'timed' ? timing.timeZone : null,
    startDate: timing.kind === 'allDay' ? timing.startDate : null,
    endDate: timing.kind === 'allDay' ? timing.endDate : null,
    recurrence: event.recurrence ?? null,
    exceptionDates: event.exceptionDates ? [...event.exceptionDates] : null,
    sequence: event.sequence ?? null,
    searchSpan: computeSearchSpan(event),
  };
}

export function fromEventRow(row: EventRow): CalendarEvent {
  const timing: EventTiming =
    row.timingKind === 'allDay'
      ? { kind: 'allDay', startDate: expectDate(row.startDate), endDate: expectDate(row.endDate) }
      : {
          kind: 'timed',
          start: toIsoLocal(expectString(row.startLocal, 'start_local')),
          end: toIsoLocal(expectString(row.endLocal, 'end_local')),
          timeZone: expectString(row.timeZone, 'time_zone'),
        };

  const event: CalendarEvent = {
    id: row.id as EventId,
    tenantId: row.tenantId as TenantId,
    calendarId: row.calendarId as CalendarId,
    uid: row.uid,
    title: row.title,
    timing,
  };

  // Assigned conditionally rather than as `?? undefined`, because
  // exactOptionalPropertyTypes distinguishes an absent key from an explicit
  // undefined and the two serialise differently.
  if (row.description !== null) event.description = row.description;
  if (row.location !== null) event.location = row.location;
  if (row.status !== null) event.status = row.status;
  if (row.recurrence !== null) event.recurrence = row.recurrence;
  if (row.exceptionDates !== null) event.exceptionDates = row.exceptionDates;
  if (row.sequence !== null) event.sequence = row.sequence;

  return event;
}

/**
 * A conservative superset of every instant this event could occupy, as a
 * Postgres `tstzrange` literal.
 *
 * INVARIANT: never narrower than reality. A too-wide span costs one wasted
 * expansion; a too-narrow one silently drops events from a query, and nothing
 * downstream can detect that it happened. Every judgement call below rounds
 * outward.
 */
export function computeSearchSpan(event: CalendarEvent): string {
  const timing = event.timing;

  const [lower, upperOfFirst] =
    timing.kind === 'allDay'
      ? [
          // Floating dates have no instant until a zone is chosen, and the
          // zone is the caller's, not ours -- so bound by the widest zone
          // anyone could ask from.
          Temporal.PlainDate.from(timing.startDate)
            .toZonedDateTime({ timeZone: 'UTC' })
            .subtract({ hours: ALL_DAY_PAD_HOURS })
            .toInstant(),
          Temporal.PlainDate.from(timing.endDate)
            .toZonedDateTime({ timeZone: 'UTC' })
            .add({ hours: ALL_DAY_PAD_HOURS })
            .toInstant(),
        ]
      : [
          Temporal.PlainDateTime.from(timing.start).toZonedDateTime(timing.timeZone).toInstant(),
          Temporal.PlainDateTime.from(timing.end).toZonedDateTime(timing.timeZone).toInstant(),
        ];

  if (!event.recurrence) {
    return range(lower, upperOfFirst);
  }

  const until = parseUntil(event.recurrence);
  if (!until) {
    // Unbounded, or COUNT-bounded. COUNT could be tightened by expanding the
    // rule at write time, but expansion is capped and a dense rule would make
    // writes expensive to save a read that the GiST index already makes
    // cheap. Infinity is correct, just less selective.
    return `[${lower.toString()},)`;
  }

  // The first occurrence's duration also applies to the last one.
  const duration = upperOfFirst.epochMilliseconds - lower.epochMilliseconds;
  const upper = until
    .add({ milliseconds: duration })
    .add({ hours: UNTIL_SLACK_HOURS + (timing.kind === 'allDay' ? ALL_DAY_PAD_HOURS : 0) });

  return range(lower, upper);
}

/**
 * `[lower,upper)` -- inclusive lower, exclusive upper, matching QueryWindow.
 *
 * A zero-length event would produce `[t,t)`, which Postgres treats as an EMPTY
 * range that overlaps nothing -- so the pre-filter would silently drop it and
 * the event would vanish from every query. Phase 1 has a fixture for exactly
 * this shape, and it is what caught it.
 *
 * Widening by a millisecond keeps the range non-empty. Safe by construction:
 * the span only ever has to be a superset, so erring wider costs at most one
 * expansion that returns nothing.
 */
function range(lower: Temporal.Instant, upper: Temporal.Instant): string {
  const safeUpper =
    Temporal.Instant.compare(upper, lower) <= 0 ? lower.add({ milliseconds: 1 }) : upper;
  return `[${lower.toString()},${safeUpper.toString()})`;
}

/**
 * Extracts UNTIL from an RRULE.
 *
 * RFC 5545 allows both a UTC date-time (`20260603T130000Z`) and a bare date
 * (`20260603`). A bare date is treated as the START of that day, which is
 * earlier than any instant within it -- and since UNTIL_SLACK_HOURS is added
 * afterwards, the result still rounds outward.
 *
 * Returns null when absent or unparseable. Null means "unbounded", which is
 * the conservative reading: a malformed rule must never produce a narrow
 * span.
 */
function parseUntil(recurrence: string): Temporal.Instant | null {
  const match = /(?:^|;)UNTIL=([0-9TZ]+)/i.exec(recurrence.replace(/^RRULE:/i, ''));
  const value = match?.[1];
  if (!value) return null;

  try {
    if (/^\d{8}T\d{6}Z$/.test(value)) {
      return Temporal.Instant.from(
        `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T` +
          `${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
      );
    }
    if (/^\d{8}$/.test(value)) {
      return Temporal.PlainDate.from(
        `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`,
      )
        .toZonedDateTime({ timeZone: 'UTC' })
        .toInstant();
    }
  } catch {
    return null;
  }
  return null;
}

function expectString(value: string | null, column: string): string {
  if (value === null) {
    // The CHECK constraints make this unreachable from the database. It fires
    // only if a row was built in memory that the database would have refused.
    throw new Error(`events.${column} is null on a timed event; the row violates its CHECK constraint`);
  }
  return value;
}

/**
 * Postgres renders `timestamp` as `2026-03-01 09:00:00` -- a SPACE separator,
 * not the `T` that ISO 8601 and RFC 5545 use.
 *
 * Temporal happily accepts the space, so every code path that expands an
 * event normalised it invisibly and nothing noticed. The ICS feed is the
 * first path that serialises a STORED value without expanding it first, and
 * there `compactDateTime` split on `T`, found none, and emitted
 * `20260301 09:00:00T000000` -- which no calendar client can read.
 *
 * Normalised here, at the boundary, so `EventTiming.start` means what its
 * type says everywhere rather than being conditionally ISO.
 */
function toIsoLocal(value: string): string {
  // Also drops a trailing zone marker: these columns are `timestamp WITHOUT
  // time zone`, so anything Postgres appends would be meaningless here.
  return value.replace(' ', 'T').replace(/(?:Z|[+-]\d{2}(?::?\d{2})?)$/, '');
}

function expectDate(value: string | null): string {
  if (value === null) {
    throw new Error('events.start_date/end_date is null on an all-day event');
  }
  // Postgres `date` comes back as YYYY-MM-DD, which is already what the
  // floating-date model wants. Slicing guards against a driver that decides
  // to hand back a timestamp.
  return value.slice(0, 10);
}
