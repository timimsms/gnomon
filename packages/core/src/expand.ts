import { RRuleTemporal } from 'rrule-temporal';
import { Temporal } from './temporal.js';
import type {
  CalendarEvent,
  EventOccurrence,
  EventTiming,
  QueryWindow,
  RecurrenceOverride,
  TimeZoneId,
} from './types.js';
import { assertWindow, MAX_OCCURRENCES, TooManyOccurrencesError } from './window.js';

/**
 * Recurrence expansion.
 *
 * Occurrences are expanded on read and never materialised (ADR-0007). Every
 * path through this module passes through `assertWindow` and the occurrence
 * cap -- there must be no way to expand a rule unbounded, because embeds are
 * public by design and host portals hand out tokens liberally.
 *
 * Where RFC 5545 is silent or implementations disagree, the choice is stated
 * in a DECISION comment and pinned by a fixture in test/fixtures. Those are
 * the interesting parts of this file; the rest is bookkeeping.
 */

export interface ExpandOptions {
  /**
   * Zone in which floating all-day dates are resolved against the instant
   * window. Per ADR-0005 all-day events have no zone of their own, so
   * comparing them to an instant range requires choosing one here rather
   * than baking one into storage.
   */
  renderTimeZone: TimeZoneId;
  overrides?: readonly RecurrenceOverride[];
  /** Defaults to MAX_OCCURRENCES. Lower it for cheap callers; it cannot be raised past the cap. */
  maxOccurrences?: number;
}

/** Frequencies where the time of day is the subject of the rule, not incidental to it. */
const SUB_DAILY = /FREQ=(HOURLY|MINUTELY|SECONDLY)/i;
const EXPANDS_TIME = /BY(HOUR|MINUTE|SECOND)=/i;

/** Any BY* part that determines which day of the period an occurrence lands on. */
const SELECTS_DAY = /BY(MONTHDAY|DAY|YEARDAY|WEEKNO|SETPOS)=/i;

/**
 * CORRECTION: rrule-temporal clamps an implied day-of-month instead of
 * skipping it, and the clamp is sticky.
 *
 *   FREQ=MONTHLY, DTSTART 2026-01-31
 *     returns  Jan 31, Feb 28, Mar 28, Apr 28
 *     expected Jan 31, Mar 31, May 31, Jul 31
 *
 * Note that March is wrong even though March has a 31st: the cursor is moved
 * to the clamped date and every later occurrence inherits it. The identical
 * rule written with an explicit `BYMONTHDAY=31` is handled correctly, and
 * `FREQ=YEARLY` from 29 February fails the same way.
 *
 * RFC 5545 3.3.10 says BYMONTHDAY, when absent for a MONTHLY or YEARLY rule,
 * defaults to DTSTART's day of month -- and BYMONTH likewise for YEARLY. So
 * making that default explicit is exactly what the spec already means, and it
 * routes the rule onto the library's correct code path rather than
 * post-filtering its wrong one.
 */
function normalizeRule(recurrence: string, dtstart: Temporal.ZonedDateTime): string {
  const value = recurrence.replace(/^RRULE:/i, '');
  if (SELECTS_DAY.test(value)) return value;

  if (/FREQ=MONTHLY/i.test(value)) {
    return `${value};BYMONTHDAY=${dtstart.day}`;
  }

  if (/FREQ=YEARLY/i.test(value) && !/BYMONTH=/i.test(value)) {
    return `${value};BYMONTH=${dtstart.month};BYMONTHDAY=${dtstart.day}`;
  }

  return value;
}

/** Builds a configured rule. The only place `RRuleTemporal` is constructed. */
function buildRule(
  recurrence: string,
  dtstart: Temporal.ZonedDateTime,
  exDates: readonly Temporal.ZonedDateTime[],
  cap: number,
): RRuleTemporal {
  return new RRuleTemporal({
    rruleString: `RRULE:${normalizeRule(recurrence, dtstart)}`,
    dtstart,
    ...(exDates.length ? { exDate: [...exDates] } : {}),
    // DECISION: a DTSTART that does not match the rule is NOT emitted as an
    // occurrence. RFC 5545 3.3.10 declares this case explicitly undefined
    // ("the recurrence set generated with a DTSTART not synchronized with the
    // recurrence rule is undefined"), so there is no correct answer to
    // inherit. We follow the dominant convention -- python-dateutil, rrule.js,
    // and rrule-temporal's own default all exclude it.
    includeDtstart: false,
    // Density guard inside the library, in addition to our own cap. Padded
    // above the cap so our own error is the one callers normally see.
    maxIterations: cap * 2,
  });
}

/** Runs a bounded sweep, translating the library's ceiling into our own error. */
function sweep(
  rule: RRuleTemporal,
  from: Temporal.ZonedDateTime,
  to: Temporal.ZonedDateTime,
  cap: number,
): Temporal.ZonedDateTime[] {
  let raw: Temporal.ZonedDateTime[];
  try {
    // `between` is exclusive at both bounds by default; we sweep inclusively
    // and apply our own half-open window semantics afterwards.
    raw = rule.between(from, to, true) as Temporal.ZonedDateTime[];
  } catch (error) {
    // The library throws on its own iteration ceiling; surface it as ours so
    // callers have one error to handle rather than a leaked dependency type.
    if (error instanceof Error && /Maximum iterations/i.test(error.message)) {
      throw new TooManyOccurrencesError(cap);
    }
    throw error;
  }

  if (raw.length > cap) throw new TooManyOccurrencesError(cap);
  return raw;
}

export function expandEvent(
  event: CalendarEvent,
  window: QueryWindow,
  options: ExpandOptions,
): EventOccurrence[] {
  assertWindow(window);

  const cap = Math.min(options.maxOccurrences ?? MAX_OCCURRENCES, MAX_OCCURRENCES);
  const from = Temporal.Instant.from(window.from);
  const to = Temporal.Instant.from(window.to);

  const occurrences =
    event.timing.kind === 'allDay'
      ? expandAllDay(event, event.timing, from, to, options, cap)
      : expandTimed(event, event.timing, from, to, options, cap);

  return occurrences.sort(compareOccurrences);
}

export function expandEvents(
  events: readonly CalendarEvent[],
  window: QueryWindow,
  options: ExpandOptions,
): EventOccurrence[] {
  assertWindow(window);

  const all: EventOccurrence[] = [];
  for (const event of events) {
    all.push(...expandEvent(event, window, options));
    // Cap across the whole request, not per event: fifty events of two
    // hundred occurrences each is the same load as one of ten thousand.
    if (all.length > (options.maxOccurrences ?? MAX_OCCURRENCES)) {
      throw new TooManyOccurrencesError(options.maxOccurrences ?? MAX_OCCURRENCES);
    }
  }
  return all.sort(compareOccurrences);
}

// ---------------------------------------------------------------------------
// Timed events
// ---------------------------------------------------------------------------

function expandTimed(
  event: CalendarEvent,
  timing: Extract<EventTiming, { kind: 'timed' }>,
  from: Temporal.Instant,
  to: Temporal.Instant,
  options: ExpandOptions,
  cap: number,
): EventOccurrence[] {
  const zone = timing.timeZone;
  const startPdt = Temporal.PlainDateTime.from(timing.start);
  const endPdt = Temporal.PlainDateTime.from(timing.end);
  const dtstart = startPdt.toZonedDateTime(zone);

  // DECISION: duration is preserved as NOMINAL wall-clock, not as elapsed
  // time. A 09:00-17:00 shift stays 09:00-17:00 on every occurrence, including
  // days that are 23 or 25 hours long. The alternative (exact elapsed
  // duration) makes the displayed end time drift by an hour twice a year,
  // which reads as a bug to every user who sees it.
  const nominalDuration = startPdt.until(endPdt, { largestUnit: 'day' });

  const starts = event.recurrence
    ? recurringStarts(event.recurrence, dtstart, timing, event.exceptionDates, from, to, cap)
    : [dtstart];

  const overrides = indexOverrides(options.overrides);
  const out: EventOccurrence[] = [];
  const consumed = new Set<string>();

  for (const start of starts) {
    const recurrenceId = event.recurrence ? start.toInstant().toString() : undefined;
    const override = recurrenceId ? overrides.get(recurrenceId) : undefined;
    if (override) consumed.add(recurrenceId as string);

    // DECISION: a cancelled instance (patch === null) is omitted from
    // expansion. It still exists in storage and still round-trips through
    // ICS as a cancelled instance -- it is simply not something a calendar
    // view should draw.
    if (override && override.patch === null) continue;

    const base: EventTiming = {
      kind: 'timed',
      start: start.toPlainDateTime().toString(),
      end: start.toPlainDateTime().add(nominalDuration).toString(),
      timeZone: zone,
    };

    const occurrence = buildOccurrence(event, base, recurrenceId, override?.patch);
    if (overlapsWindow(occurrence.timing, from, to, options.renderTimeZone)) {
      out.push(occurrence);
    }
  }

  // An override may move an instance INTO the window from outside it. Those
  // instances never appear in the loop above, because the rule-produced start
  // they replace falls outside the queried range.
  out.push(...movedIntoWindow(event, overrides, consumed, from, to, options));

  return out;
}

/**
 * Produces rule-generated start instants, with two corrections applied to
 * `rrule-temporal` output. Both are pinned by fixtures.
 */
function recurringStarts(
  recurrence: string,
  dtstart: Temporal.ZonedDateTime,
  timing: Extract<EventTiming, { kind: 'timed' }>,
  exceptionDates: readonly string[] | undefined,
  from: Temporal.Instant,
  to: Temporal.Instant,
  cap: number,
): Temporal.ZonedDateTime[] {
  const zone = timing.timeZone;
  const rule = buildRule(
    recurrence,
    dtstart,
    (exceptionDates ?? []).map((d) => toZoned(d, zone)),
    cap,
  );

  // The lower bound is pulled back a day so an occurrence starting before
  // `from` but still running at `from` is not dropped before the overlap test
  // gets to see it.
  const raw = sweep(
    rule,
    from.subtract({ hours: 24 }).toZonedDateTimeISO(zone),
    to.toZonedDateTimeISO(zone),
    cap,
  );

  return raw.map((occ) => reanchorWallClock(occ, dtstart, recurrence, zone));
}

/**
 * CORRECTION: rrule-temporal permanently shifts the time of day after a
 * DST gap.
 *
 * A daily 02:30 series in America/New_York returns 03:30 on 2026-03-08 --
 * correct, since 02:30 does not exist that day -- but then returns 03:30 on
 * every subsequent day too, even though 02:30 exists again. Its own source
 * acknowledges this: the iteration cursor chains through gap days and carries
 * the shift forward.
 *
 * The expected behaviour, and Google Calendar's, is that only the affected
 * day moves. We restore it by re-anchoring each occurrence to DTSTART's
 * wall-clock time, letting Temporal's 'compatible' disambiguation shift
 * forward across a gap and pick the earlier instant in an overlap -- which
 * reproduces the correct one-day shift and nothing more.
 *
 * Applied only when the time of day is incidental to the rule. For sub-daily
 * frequencies, or rules that expand BYHOUR/BYMINUTE/BYSECOND, the varying
 * time IS the rule and must not be flattened.
 */
function reanchorWallClock(
  occurrence: Temporal.ZonedDateTime,
  dtstart: Temporal.ZonedDateTime,
  recurrence: string,
  zone: TimeZoneId,
): Temporal.ZonedDateTime {
  if (SUB_DAILY.test(recurrence) || EXPANDS_TIME.test(recurrence)) return occurrence;

  return occurrence.toPlainDate().toZonedDateTime({
    timeZone: zone,
    plainTime: dtstart.toPlainTime(),
  });
}

// ---------------------------------------------------------------------------
// All-day events
// ---------------------------------------------------------------------------

function expandAllDay(
  event: CalendarEvent,
  timing: Extract<EventTiming, { kind: 'allDay' }>,
  from: Temporal.Instant,
  to: Temporal.Instant,
  options: ExpandOptions,
  cap: number,
): EventOccurrence[] {
  const startDate = Temporal.PlainDate.from(timing.startDate);
  const endDate = Temporal.PlainDate.from(timing.endDate);
  const spanDays = startDate.until(endDate, { largestUnit: 'day' });

  let startDates: Temporal.PlainDate[];

  if (!event.recurrence) {
    startDates = [startDate];
  } else {
    // UTC is used here purely as a computation carrier, NOT as an anchor.
    // All-day events are floating (ADR-0005); UTC is chosen because it has no
    // DST transitions, so date arithmetic through the rule engine is exact and
    // cannot introduce an offset artefact. The zone is discarded immediately
    // after via toPlainDate().
    const carrier = startDate.toZonedDateTime({ timeZone: 'UTC' });
    const rule = buildRule(
      event.recurrence,
      carrier,
      (event.exceptionDates ?? []).map((d) =>
        Temporal.PlainDate.from(d.slice(0, 10)).toZonedDateTime({ timeZone: 'UTC' }),
      ),
      cap,
    );

    // Widen the sweep by the event's own span so a multi-day all-day event
    // that began before the window is still found.
    const raw = sweep(
      rule,
      from.toZonedDateTimeISO('UTC').subtract(spanDays).subtract({ hours: 24 }).startOfDay(),
      to.toZonedDateTimeISO('UTC').add({ hours: 24 }),
      cap,
    );

    startDates = raw.map((z) => z.toPlainDate());
  }

  const overrides = indexOverrides(options.overrides);
  const out: EventOccurrence[] = [];
  const consumed = new Set<string>();

  for (const date of startDates) {
    const recurrenceId = event.recurrence ? date.toString() : undefined;
    const override = recurrenceId ? overrides.get(recurrenceId) : undefined;
    if (override) consumed.add(recurrenceId as string);
    if (override && override.patch === null) continue;

    const base: EventTiming = {
      kind: 'allDay',
      startDate: date.toString(),
      endDate: date.add(spanDays).toString(),
    };

    const occurrence = buildOccurrence(event, base, recurrenceId, override?.patch);
    if (overlapsWindow(occurrence.timing, from, to, options.renderTimeZone)) {
      out.push(occurrence);
    }
  }

  out.push(...movedIntoWindow(event, overrides, consumed, from, to, options));

  return out;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function indexOverrides(
  overrides: readonly RecurrenceOverride[] | undefined,
): Map<string, RecurrenceOverride> {
  const map = new Map<string, RecurrenceOverride>();
  for (const override of overrides ?? []) {
    const existing = map.get(override.recurrenceId);
    // RFC 5545 SEQUENCE resolves conflicting overrides for the same instance:
    // higher wins. Absent SEQUENCE is treated as 0, so an explicit revision
    // always beats one that never declared itself.
    if (!existing || (override.sequence ?? 0) >= (existing.sequence ?? 0)) {
      map.set(override.recurrenceId, override);
    }
  }
  return map;
}

/**
 * Overrides whose replacement timing falls inside the window even though the
 * instance they replace does not. Without this, moving an event from just
 * outside the window to just inside it makes the event vanish.
 */
function movedIntoWindow(
  event: CalendarEvent,
  overrides: Map<string, RecurrenceOverride>,
  consumed: Set<string>,
  from: Temporal.Instant,
  to: Temporal.Instant,
  options: ExpandOptions,
): EventOccurrence[] {
  const out: EventOccurrence[] = [];

  for (const [recurrenceId, override] of overrides) {
    if (consumed.has(recurrenceId)) continue;
    if (override.patch === null) continue;
    if (!override.patch.timing) continue;

    const occurrence = buildOccurrence(event, override.patch.timing, recurrenceId, override.patch);
    if (overlapsWindow(occurrence.timing, from, to, options.renderTimeZone)) {
      out.push(occurrence);
    }
  }

  return out;
}

function buildOccurrence(
  event: CalendarEvent,
  timing: EventTiming,
  recurrenceId: string | undefined,
  patch: RecurrenceOverride['patch'] | undefined,
): EventOccurrence {
  const occurrence: EventOccurrence = {
    eventId: event.id,
    calendarId: event.calendarId,
    title: patch?.title ?? event.title,
    timing: patch?.timing ?? timing,
    isOverride: Boolean(patch),
  };

  // Assigned conditionally rather than as `?? undefined` because
  // exactOptionalPropertyTypes distinguishes an absent key from an explicit
  // undefined, and the two serialise differently.
  const description = patch?.description ?? event.description;
  if (description !== undefined) occurrence.description = description;

  const location = patch?.location ?? event.location;
  if (location !== undefined) occurrence.location = location;

  const status = patch?.status ?? event.status;
  if (status !== undefined) occurrence.status = status;

  if (recurrenceId !== undefined) occurrence.recurrenceId = recurrenceId;

  return occurrence;
}

/**
 * Half-open overlap: an occurrence is in the window if it starts before `to`
 * and ends after `from`.
 *
 * Zero-duration occurrences are special-cased. Under the general rule they
 * would never match -- `end > from` is false when `end === start === from` --
 * so a zero-length event exactly at the window start would silently vanish.
 */
function overlapsWindow(
  timing: EventTiming,
  from: Temporal.Instant,
  to: Temporal.Instant,
  renderTimeZone: TimeZoneId,
): boolean {
  const [start, end] = timingToInstants(timing, renderTimeZone);

  if (Temporal.Instant.compare(start, end) === 0) {
    return Temporal.Instant.compare(start, from) >= 0 && Temporal.Instant.compare(start, to) < 0;
  }

  return Temporal.Instant.compare(start, to) < 0 && Temporal.Instant.compare(end, from) > 0;
}

function timingToInstants(
  timing: EventTiming,
  renderTimeZone: TimeZoneId,
): [Temporal.Instant, Temporal.Instant] {
  if (timing.kind === 'timed') {
    return [
      toZoned(timing.start, timing.timeZone).toInstant(),
      toZoned(timing.end, timing.timeZone).toInstant(),
    ];
  }

  // A floating date has no instant until a zone is chosen. That choice is the
  // caller's rendering zone -- which is why the same all-day event can fall
  // inside the window for a viewer in Auckland and outside it for one in
  // Honolulu. That is correct, not a rounding error.
  return [
    Temporal.PlainDate.from(timing.startDate).toZonedDateTime({ timeZone: renderTimeZone })
      .toInstant(),
    Temporal.PlainDate.from(timing.endDate).toZonedDateTime({ timeZone: renderTimeZone })
      .toInstant(),
  ];
}

/** Accepts a wall-clock local date-time or an instant with an offset/Z. */
function toZoned(value: string, zone: TimeZoneId): Temporal.ZonedDateTime {
  return /[Zz]$|[+-]\d{2}:?\d{2}$/.test(value)
    ? Temporal.Instant.from(value).toZonedDateTimeISO(zone)
    : Temporal.PlainDateTime.from(value).toZonedDateTime(zone);
}

function compareOccurrences(a: EventOccurrence, b: EventOccurrence): number {
  const aStart = a.timing.kind === 'timed' ? a.timing.start : a.timing.startDate;
  const bStart = b.timing.kind === 'timed' ? b.timing.start : b.timing.startDate;
  if (aStart !== bStart) return aStart < bStart ? -1 : 1;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}
