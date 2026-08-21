import { Temporal } from '../temporal.js';
import type { CalendarEvent, EventTiming, TimeZoneId } from '../types.js';

/**
 * RFC 5545 serialisation.
 *
 * Hand-rolled rather than taken from a dependency: the output surface is
 * narrow and entirely under our control, so a library buys little and costs
 * line-folding surprises. Parsing is the opposite -- it must accept whatever
 * the world sends -- which is why that half uses `node-ical` (ADR-0008).
 *
 * This module is pure. It lives under `ics/` because ICS interop is one
 * coherent surface, not because it needs anything Node provides.
 */

export interface SerializeInput {
  events: readonly CalendarEvent[];
  /** X-WR-CALNAME. Calendar clients show this as the subscription's name. */
  name?: string;
  /**
   * X-WR-TIMEZONE. Non-standard, and honoured by Google, Apple and Outlook
   * alike as the calendar's default zone -- which is why a feed sets it even
   * though RFC 5545 does not define it.
   */
  timeZone?: string;
  /** Defaults to a Gnomon identifier. */
  productId?: string;
}

const CRLF = '\r\n';
const DEFAULT_PRODID = '-//Gnomon//Gnomon Calendar//EN';

/** RFC 5545 3.1: content lines are folded at 75 OCTETS, not 75 characters. */
const OCTET_LIMIT = 75;

export function serializeCalendar(input: SerializeInput): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${input.productId ?? DEFAULT_PRODID}`,
    'CALSCALE:GREGORIAN',
  ];

  if (input.name !== undefined) {
    lines.push(`X-WR-CALNAME:${escapeText(input.name)}`);
  }
  if (input.timeZone !== undefined) {
    lines.push(`X-WR-TIMEZONE:${escapeText(input.timeZone)}`);
  }

  for (const zone of referencedZones(input.events)) {
    lines.push(...timeZoneComponent(zone, input.events));
  }

  for (const event of input.events) {
    lines.push(...eventComponent(event));
  }

  lines.push('END:VCALENDAR');

  // CRLF unconditionally, including the trailing one. RFC 5545 3.1 requires
  // it, and a file ending without it is rejected by stricter parsers.
  return lines.map(foldLine).join(CRLF) + CRLF;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function eventComponent(event: CalendarEvent): string[] {
  const lines = ['BEGIN:VEVENT', `UID:${escapeText(event.uid)}`];

  // DTSTAMP is required. It means "when this representation was created",
  // which is not something the domain model tracks, so it is derived from
  // the event's start rather than from the clock -- serialising the same
  // event twice must produce identical bytes, or ETags churn and every
  // conditional GET misses.
  lines.push(`DTSTAMP:${utcStamp(event.timing)}`);
  lines.push(...timingLines(event.timing));

  lines.push(`SUMMARY:${escapeText(event.title)}`);
  if (event.description !== undefined) {
    lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  }
  if (event.location !== undefined) {
    lines.push(`LOCATION:${escapeText(event.location)}`);
  }
  if (event.status !== undefined) {
    lines.push(`STATUS:${event.status.toUpperCase()}`);
  }
  if (event.sequence !== undefined) {
    lines.push(`SEQUENCE:${event.sequence}`);
  }
  if (event.recurrence !== undefined) {
    lines.push(`RRULE:${canonicalRRule(event.recurrence)}`);
  }
  if (event.exceptionDates?.length) {
    lines.push(...exceptionLines(event.timing, event.exceptionDates));
  }

  lines.push('END:VEVENT');
  return lines;
}

function timingLines(timing: EventTiming): string[] {
  if (timing.kind === 'allDay') {
    // VALUE=DATE is what makes this a floating all-day event rather than
    // midnight in some zone (ADR-0005). DTEND is already exclusive in our
    // model, which is exactly what RFC 5545 expects here.
    return [
      `DTSTART;VALUE=DATE:${compactDate(timing.startDate)}`,
      `DTEND;VALUE=DATE:${compactDate(timing.endDate)}`,
    ];
  }

  // TZID rather than a UTC instant, because a recurring event converted to
  // UTC expands wrongly across a DST boundary -- the wall-clock time is the
  // thing the rule is anchored to.
  return [
    `DTSTART;TZID=${timing.timeZone}:${compactDateTime(timing.start)}`,
    `DTEND;TZID=${timing.timeZone}:${compactDateTime(timing.end)}`,
  ];
}

function exceptionLines(timing: EventTiming, exceptions: readonly string[]): string[] {
  if (timing.kind === 'allDay') {
    const dates = exceptions.map((value) => compactDate(value.slice(0, 10)));
    return [`EXDATE;VALUE=DATE:${dates.join(',')}`];
  }

  // EXDATEs are stored either as wall-clock in the event's zone or as an
  // instant; both are normalised to the event's zone here so the emitted
  // values match DTSTART's form, which is what clients compare against.
  const zone = timing.timeZone;
  const values = exceptions.map((value) => compactDateTime(toZoned(value, zone).toPlainDateTime().toString()));
  return [`EXDATE;TZID=${zone}:${values.join(',')}`];
}

// ---------------------------------------------------------------------------
// VTIMEZONE
// ---------------------------------------------------------------------------

function referencedZones(events: readonly CalendarEvent[]): string[] {
  const zones = new Set<string>();
  for (const event of events) {
    if (event.timing.kind === 'timed') zones.add(event.timing.timeZone);
  }
  // UTC needs no VTIMEZONE, and emitting one for it confuses some clients.
  zones.delete('UTC');
  return [...zones].sort();
}

/**
 * Emits a VTIMEZONE with one sub-component per actual offset transition,
 * derived from the platform's IANA data via `getTimeZoneTransition`.
 *
 * The alternative -- a single STANDARD/DAYLIGHT pair carrying an RRULE -- is
 * more compact but requires inferring a recurrence pattern from observed
 * transitions, which is guesswork that goes wrong exactly when a jurisdiction
 * changes its rules. Explicit transitions cannot be wrong about history.
 *
 * The cost is feed size for long ranges. Phase 5 may want RRULE compression
 * for subscription feeds; correctness first.
 */
function timeZoneComponent(zone: TimeZoneId, events: readonly CalendarEvent[]): string[] {
  const [rangeStart, rangeEnd] = zoneRange(zone, events);

  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`];
  let cursor: Temporal.ZonedDateTime | null = rangeStart;
  let emitted = 0;

  while (cursor && emitted < MAX_TRANSITIONS) {
    const next: Temporal.ZonedDateTime | null = cursor.getTimeZoneTransition('next');
    if (!next || Temporal.ZonedDateTime.compare(next, rangeEnd) > 0) break;

    lines.push(...transitionComponent(next, zone));
    cursor = next;
    emitted += 1;
  }

  if (emitted === 0) {
    // A zone with no transitions in range still needs one sub-component, or
    // the VTIMEZONE is invalid and clients reject the whole calendar.
    lines.push(...fixedOffsetComponent(rangeStart, zone));
  }

  lines.push('END:VTIMEZONE');
  return lines;
}

/** Bounds VTIMEZONE emission for zones whose data is dense or ranges that are wide. */
const MAX_TRANSITIONS = 64;

function zoneRange(
  zone: TimeZoneId,
  events: readonly CalendarEvent[],
): [Temporal.ZonedDateTime, Temporal.ZonedDateTime] {
  let earliest: Temporal.ZonedDateTime | undefined;

  for (const event of events) {
    if (event.timing.kind !== 'timed' || event.timing.timeZone !== zone) continue;
    const start = toZoned(event.timing.start, zone);
    if (!earliest || Temporal.ZonedDateTime.compare(start, earliest) < 0) earliest = start;
  }

  // A year either side of the events covers the transitions a client needs to
  // interpret them, without emitting a century of history.
  const anchor = earliest ?? Temporal.Now.zonedDateTimeISO(zone);
  return [anchor.subtract({ years: 1 }), anchor.add({ years: 2 })];
}

function transitionComponent(
  transition: Temporal.ZonedDateTime,
  zone: TimeZoneId,
): string[] {
  // The transition is rendered in the NEW offset. The instant one nanosecond
  // earlier is still in the old one, which is where TZOFFSETFROM comes from.
  const before = transition.subtract({ nanoseconds: 1 });
  const offsetFrom = before.offset;
  const offsetTo = transition.offset;

  // DTSTART inside a VTIMEZONE sub-component is local time in the FROM
  // offset -- the wall clock a reader would have seen just before the change.
  const localInFromOffset = transition.toInstant().toZonedDateTimeISO(offsetFrom);

  // Daylight is simply the side with the larger (less negative) offset.
  const isDaylight = transition.offsetNanoseconds > before.offsetNanoseconds;
  const tag = isDaylight ? 'DAYLIGHT' : 'STANDARD';

  return [
    `BEGIN:${tag}`,
    `DTSTART:${compactDateTime(localInFromOffset.toPlainDateTime().toString())}`,
    `TZOFFSETFROM:${compactOffset(offsetFrom)}`,
    `TZOFFSETTO:${compactOffset(offsetTo)}`,
    `TZNAME:${abbreviation(transition, zone)}`,
    `END:${tag}`,
  ];
}

function fixedOffsetComponent(at: Temporal.ZonedDateTime, zone: TimeZoneId): string[] {
  const offset = compactOffset(at.offset);
  return [
    'BEGIN:STANDARD',
    // A zone without transitions has no meaningful start; the RFC-conventional
    // placeholder is the epoch.
    'DTSTART:19700101T000000',
    `TZOFFSETFROM:${offset}`,
    `TZOFFSETTO:${offset}`,
    `TZNAME:${abbreviation(at, zone)}`,
    'END:STANDARD',
  ];
}

function abbreviation(at: Temporal.ZonedDateTime, zone: TimeZoneId): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    timeZoneName: 'short',
  }).formatToParts(new Date(at.toInstant().epochMilliseconds));

  // Falls back to the numeric offset when Intl yields something like
  // "GMT+5:30" -- a TZNAME is required and any stable string satisfies it.
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? compactOffset(at.offset);
}

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

/**
 * RFC 5545 requires FREQ first and leaves the order of the remaining rule
 * parts free, so the same rule has many equally valid spellings. Parsers
 * reorder them -- `node-ical` returns `FREQ=WEEKLY;BYDAY=MO;COUNT=3` as
 * `FREQ=WEEKLY;COUNT=3;BYDAY=MO`.
 *
 * That is harmless semantically and expensive operationally: an ICS feed
 * whose bytes change every time it is regenerated defeats the ETag and
 * conditional-GET work in phases 3.3 and 5.3, and makes a round trip
 * byte-unstable on its first pass. Emitting a canonical order means two feeds
 * expressing one rule differently serialise identically.
 */
export function canonicalRRule(rule: string): string {
  const ORDER = [
    'FREQ',
    'INTERVAL',
    'WKST',
    'COUNT',
    'UNTIL',
    'BYMONTH',
    'BYWEEKNO',
    'BYYEARDAY',
    'BYMONTHDAY',
    'BYDAY',
    'BYHOUR',
    'BYMINUTE',
    'BYSECOND',
    'BYSETPOS',
  ];

  const parts = rule
    .replace(/^RRULE:/i, '')
    .split(';')
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=');
      return index === -1
        ? { key: part.toUpperCase(), value: '' }
        : { key: part.slice(0, index).toUpperCase(), value: part.slice(index + 1) };
    });

  const rank = (key: string) => {
    const index = ORDER.indexOf(key);
    // Unrecognised parts (RSCALE, SKIP, X-*) keep their relative order and
    // sort last, rather than being dropped.
    return index === -1 ? ORDER.length : index;
  };

  return parts
    .map((part, index) => ({ ...part, index }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.index - b.index)
    .map((part) => (part.value === '' ? part.key : `${part.key}=${part.value}`))
    .join(';');
}

/** "2026-10-03" -> "20261003" */
export function compactDate(value: string): string {
  return value.replaceAll('-', '');
}

/** "2026-03-08T09:00:00" -> "20260308T090000" */
export function compactDateTime(value: string): string {
  const [date, time = '00:00:00'] = value.split('T');
  // Fractional seconds are legal in ISO 8601 but not in an RFC 5545
  // DATE-TIME, so they are dropped rather than emitted and rejected.
  const hms = time.split('.')[0] ?? '00:00:00';
  return `${(date ?? '').replaceAll('-', '')}T${hms.replaceAll(':', '')}`;
}

/** "-05:00" -> "-0500" */
export function compactOffset(offset: string): string {
  return offset.replaceAll(':', '');
}

function utcStamp(timing: EventTiming): string {
  const instant =
    timing.kind === 'allDay'
      ? Temporal.PlainDate.from(timing.startDate).toZonedDateTime({ timeZone: 'UTC' }).toInstant()
      : toZoned(timing.start, timing.timeZone).toInstant();

  return `${compactDateTime(instant.toZonedDateTimeISO('UTC').toPlainDateTime().toString())}Z`;
}

function toZoned(value: string, zone: TimeZoneId): Temporal.ZonedDateTime {
  return /[Zz]$|[+-]\d{2}:?\d{2}$/.test(value)
    ? Temporal.Instant.from(value).toZonedDateTimeISO(zone)
    : Temporal.PlainDateTime.from(value).toZonedDateTime(zone);
}

// ---------------------------------------------------------------------------
// Text escaping and folding
// ---------------------------------------------------------------------------

/**
 * RFC 5545 3.3.11. Backslash must be escaped first, or the escapes introduced
 * for the other characters get escaped in turn.
 *
 * Colon is deliberately NOT escaped: it is legal unescaped in a TEXT value,
 * and escaping it breaks round-tripping through stricter parsers.
 */
export function escapeText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll('\r\n', '\\n')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\n');
}

/**
 * Folds a content line to 75 octets.
 *
 * The classic bug here is folding by string length instead of UTF-8 byte
 * length, which either overflows the limit or splits a multi-byte character
 * across the fold and corrupts it. We accumulate by code point and measure in
 * octets, so a fold never lands inside a character.
 *
 * Continuation lines carry a leading space that counts toward the limit,
 * hence the reduced budget after the first line.
 */
export function foldLine(line: string): string {
  if (utf8Length(line) <= OCTET_LIMIT) return line;

  const pieces: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = OCTET_LIMIT;

  for (const char of line) {
    const size = utf8Length(char);
    if (bytes + size > limit) {
      pieces.push(current);
      current = '';
      bytes = 0;
      limit = OCTET_LIMIT - 1;
    }
    current += char;
    bytes += size;
  }
  pieces.push(current);

  return pieces.join(`${CRLF} `);
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const cp = char.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}
