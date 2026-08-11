import ical from 'node-ical';
import { Temporal } from '../temporal.js';
import type { CalendarEvent, EventStatus, EventTiming } from '../types.js';

/**
 * RFC 5545 parsing, via `node-ical` (ADR-0008).
 *
 * NODE ONLY. `node-ical` imports `node:fs` from its entry point, which is why
 * this lives behind the `@gnomon/core/ics` subpath and not in the main export.
 *
 * `node-ical` is used strictly as a text parser. It depends on the same
 * `rrule-temporal` we do and will happily expand recurrences itself -- and
 * would inherit all three of the defects `expand.ts` corrects. We take the raw
 * RRULE and EXDATE values and expand them with our own engine.
 */

/**
 * An event as it exists in an ICS file: everything except the identity we
 * assign. ICS has no notion of our primary keys, and pretending otherwise
 * pushes fake IDs through the parser.
 */
export type ParsedEvent = Omit<CalendarEvent, 'id' | 'calendarId' | 'tenantId'>;

export interface ParsedCalendar {
  /** X-WR-CALNAME, when the feed supplies one. */
  name?: string;
  events: ParsedEvent[];
}

export function parseCalendar(source: string): ParsedCalendar {
  const parsed = ical.sync.parseICS(source);
  const events: ParsedEvent[] = [];

  for (const value of Object.values(parsed)) {
    const component = value as IcalComponent;
    if (component.type !== 'VEVENT') continue;
    const event = toEvent(component);
    if (event) events.push(event);
  }

  const calendar: ParsedCalendar = { events };
  const name = readCalendarName(source);
  if (name !== undefined) calendar.name = name;
  return calendar;
}

/** Narrow view of what `node-ical` returns; its own types are loose. */
interface IcalComponent {
  type?: string;
  uid?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  sequence?: number | string;
  datetype?: 'date' | 'date-time';
  start?: Date & { tz?: string };
  end?: Date & { tz?: string };
  rrule?: { toString(): string };
  exdate?: Record<string, Date & { tz?: string }>;
}

function toEvent(component: IcalComponent): ParsedEvent | null {
  // An event without a start is not an event. Skipping beats throwing: one
  // malformed VEVENT in a third-party feed should not lose the other 400.
  if (!component.start || !component.uid) return null;

  const timing = toTiming(component);
  if (!timing) return null;

  const event: ParsedEvent = {
    uid: component.uid,
    title: component.summary ?? '',
    timing,
  };

  if (component.description !== undefined) event.description = component.description;
  if (component.location !== undefined) event.location = component.location;

  const status = toStatus(component.status);
  if (status !== undefined) event.status = status;

  const sequence = Number(component.sequence);
  if (Number.isFinite(sequence)) event.sequence = sequence;

  const recurrence = toRecurrence(component.rrule);
  if (recurrence !== undefined) event.recurrence = recurrence;

  const exceptions = toExceptionDates(component.exdate, timing);
  if (exceptions.length) event.exceptionDates = exceptions;

  return event;
}

function toTiming(component: IcalComponent): EventTiming | null {
  const start = component.start;
  if (!start) return null;

  if (component.datetype === 'date') {
    // HAZARD: node-ical represents a VALUE=DATE as a Date at LOCAL midnight
    // of the intended day, not UTC midnight. Reading its UTC components would
    // shift the date by one for anyone west of Greenwich. The floating date
    // (ADR-0005) is recovered from the local components, which is stable on
    // any host timezone precisely because local midnight is how it was built.
    const startDate = localDateString(start);
    const endDate = component.end
      ? localDateString(component.end)
      : // DTEND is optional; RFC 5545 makes a DATE-valued event one day long
        // when it is absent. Our endDate is exclusive, so that is start + 1.
        Temporal.PlainDate.from(startDate).add({ days: 1 }).toString();

    return { kind: 'allDay', startDate, endDate };
  }

  // A DATE-TIME without TZID is either UTC (trailing Z) or floating. We treat
  // both as UTC: a floating timed event is rare, and anchoring it to the
  // server's timezone would make the same feed parse differently per host.
  const zone = start.tz ?? 'UTC';
  const startLocal = wallClock(start, zone);
  const endLocal = component.end
    ? wallClock(component.end, component.end.tz ?? zone)
    : startLocal;

  return { kind: 'timed', start: startLocal, end: endLocal, timeZone: zone };
}

/**
 * `node-ical` hands back the rule as a wrapper whose `toString()` emits a
 * DTSTART line followed by the RRULE line. We store the RRULE value alone --
 * DTSTART lives in the event's own timing.
 */
function toRecurrence(rrule: { toString(): string } | undefined): string | undefined {
  if (!rrule) return undefined;

  for (const line of rrule.toString().split(/\r?\n/)) {
    if (line.startsWith('RRULE:')) return line.slice('RRULE:'.length).trim();
  }
  return undefined;
}

/**
 * `node-ical` keys EXDATEs by more than one string form for the same
 * exclusion, so the values are deduplicated by the moment they denote rather
 * than by key.
 */
function toExceptionDates(
  exdate: Record<string, Date> | undefined,
  timing: EventTiming,
): string[] {
  if (!exdate) return [];

  const seen = new Set<string>();
  for (const value of Object.values(exdate)) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) continue;
    seen.add(
      timing.kind === 'allDay'
        ? localDateString(value)
        : Temporal.Instant.fromEpochMilliseconds(value.getTime()).toString(),
    );
  }

  return [...seen].sort();
}

function toStatus(status: string | undefined): EventStatus | undefined {
  switch (status?.toUpperCase()) {
    case 'CONFIRMED':
      return 'confirmed';
    case 'TENTATIVE':
      return 'tentative';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return undefined;
  }
}

/** The wall-clock time this instant represents in `zone`. */
function wallClock(date: Date, zone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime())
    .toZonedDateTimeISO(zone)
    .toPlainDateTime()
    .toString();
}

/** The calendar date this Date represents in the HOST timezone. See toTiming. */
function localDateString(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * X-WR-CALNAME is not surfaced by `node-ical`'s component map, so it is read
 * from the source. Unfolding first, because a long calendar name is exactly
 * the kind of value that gets folded.
 */
function readCalendarName(source: string): string | undefined {
  const unfolded = source.replace(/\r?\n[ \t]/g, '');
  const match = /^X-WR-CALNAME(?:;[^:\r\n]*)?:(.*)$/m.exec(unfolded);
  if (!match?.[1]) return undefined;
  return unescapeText(match[1].trim());
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, char: string) =>
    char === 'n' || char === 'N' ? '\n' : char,
  );
}
