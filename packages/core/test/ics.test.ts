import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/recurrence.json' with { type: 'json' };
import {
  escapeText,
  foldLine,
  parseCalendar,
  serializeCalendar,
} from '../src/ics/index.js';
import { expandEvent } from '../src/expand.js';
import type {
  CalendarEvent,
  CalendarId,
  EventId,
  EventTiming,
  QueryWindow,
  TenantId,
} from '../src/types.js';

const NY = 'America/New_York';

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1' as EventId,
    calendarId: 'cal-1' as CalendarId,
    tenantId: 'tenant-1' as TenantId,
    uid: 'evt-1@gnomon.test',
    title: 'Weekly sync',
    timing: { kind: 'timed', start: '2026-03-01T09:00:00', end: '2026-03-01T10:00:00', timeZone: NY },
    ...overrides,
  };
}

/** Octet length, which is what RFC 5545 folding is measured in. */
const octets = (value: string) => new TextEncoder().encode(value).length;

describe('foldLine', () => {
  it('leaves a short line alone', () => {
    expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short');
  });

  it('leaves a line of exactly 75 octets alone', () => {
    const line = 'X'.repeat(75);
    expect(foldLine(line)).toBe(line);
  });

  it('folds a 76-octet line with a CRLF and a leading space', () => {
    const folded = foldLine('X'.repeat(76));
    expect(folded).toBe(`${'X'.repeat(75)}\r\n X`);
  });

  it('keeps every folded segment within 75 octets including the leading space', () => {
    const folded = foldLine(`DESCRIPTION:${'abcdefgh '.repeat(40)}`);
    // Splitting on CRLF keeps each continuation segment's leading space, which
    // counts toward the limit, so segments are measured exactly as emitted.
    for (const segment of folded.split('\r\n')) {
      expect(octets(segment)).toBeLessThanOrEqual(75);
    }
  });

  it('never splits a multi-byte character across a fold', () => {
    // The classic bug: folding by string length rather than octet length
    // either overflows the limit or cuts a UTF-8 sequence in half. Emoji are
    // four octets each and are also surrogate pairs in UTF-16, so they catch
    // both mistakes at once.
    const folded = foldLine(`SUMMARY:${'🌒'.repeat(40)}`);

    expect(folded).toContain('\r\n ');
    // A split sequence would surface as a replacement character on decode.
    expect(folded).not.toContain('�');
    // And the content must survive unfolding exactly.
    expect(folded.replaceAll('\r\n ', '')).toBe(`SUMMARY:${'🌒'.repeat(40)}`);

    for (const segment of folded.split('\r\n')) {
      expect(octets(segment)).toBeLessThanOrEqual(75);
    }
  });

  it('folds 3-byte characters without overflowing', () => {
    const folded = foldLine(`SUMMARY:${'あ'.repeat(60)}`);
    for (const segment of folded.split('\r\n')) {
      expect(octets(segment)).toBeLessThanOrEqual(75);
    }
    expect(folded.replaceAll('\r\n ', '')).toBe(`SUMMARY:${'あ'.repeat(60)}`);
  });
});

describe('escapeText', () => {
  it('escapes backslash before the characters whose escapes introduce one', () => {
    // If backslash were escaped last, the escapes added for ; and , would
    // themselves be escaped and the value would be corrupted.
    expect(escapeText('a\\b;c,d')).toBe('a\\\\b\\;c\\,d');
  });

  it('escapes newlines in all three line-ending forms', () => {
    expect(escapeText('a\r\nb\nc\rd')).toBe('a\\nb\\nc\\nd');
  });

  it('does not escape a colon', () => {
    // Legal unescaped in a TEXT value; escaping it breaks stricter parsers.
    expect(escapeText('Subject: standup')).toBe('Subject: standup');
  });
});

describe('serializeCalendar', () => {
  it('terminates every line with CRLF, including the last', () => {
    const output = serializeCalendar({ events: [event()] });
    expect(output.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(output.split('\r\n').length - 1).toBe(output.split('\n').length - 1);
  });

  it('emits all-day events as VALUE=DATE with an exclusive DTEND', () => {
    const output = serializeCalendar({
      events: [event({ timing: { kind: 'allDay', startDate: '2026-10-03', endDate: '2026-10-04' } })],
    });
    expect(output).toContain('DTSTART;VALUE=DATE:20261003');
    expect(output).toContain('DTEND;VALUE=DATE:20261004');
    expect(output).not.toContain('VTIMEZONE');
  });

  it('emits timed events with a TZID and a matching VTIMEZONE', () => {
    const output = serializeCalendar({ events: [event()] });
    expect(output).toContain(`DTSTART;TZID=${NY}:20260301T090000`);
    expect(output).toContain(`BEGIN:VTIMEZONE\r\nTZID:${NY}`);
    // Derived from real IANA transition data, so the March 2026 spring-forward
    // must appear with the correct offsets.
    expect(output).toContain('TZOFFSETFROM:-0500');
    expect(output).toContain('TZOFFSETTO:-0400');
  });

  it('emits no VTIMEZONE for UTC', () => {
    const output = serializeCalendar({
      events: [
        event({
          timing: { kind: 'timed', start: '2026-03-01T09:00:00', end: '2026-03-01T10:00:00', timeZone: 'UTC' },
        }),
      ],
    });
    expect(output).not.toContain('VTIMEZONE');
  });

  it('is deterministic -- serialising twice yields identical bytes', () => {
    // DTSTAMP is derived from the event rather than the clock precisely so
    // that this holds. Without it, every ETag churns and conditional GETs
    // never hit (phase 3.3, phase 5.3).
    const input = { events: [event({ recurrence: 'FREQ=WEEKLY;COUNT=5' })], name: 'Ops' };
    expect(serializeCalendar(input)).toBe(serializeCalendar(input));
  });
});

describe('parseCalendar', () => {
  it('recovers a timed event with its rule and exceptions', () => {
    const source = serializeCalendar({
      events: [
        event({
          recurrence: 'FREQ=WEEKLY;COUNT=5',
          exceptionDates: ['2026-03-08T09:00:00'],
        }),
      ],
    });

    const [parsed, ...rest] = parseCalendar(source).events;

    expect(rest).toHaveLength(0);
    expect(parsed?.uid).toBe('evt-1@gnomon.test');
    expect(parsed?.title).toBe('Weekly sync');
    expect(parsed?.recurrence).toBe('FREQ=WEEKLY;COUNT=5');
    expect(parsed?.timing).toEqual({
      kind: 'timed',
      start: '2026-03-01T09:00:00',
      end: '2026-03-01T10:00:00',
      timeZone: NY,
    });
    expect(parsed?.exceptionDates).toHaveLength(1);
  });

  it('does not shift an all-day date by the host timezone', () => {
    // node-ical returns a VALUE=DATE as a Date at LOCAL midnight. Reading its
    // UTC components would move 3 October to 2 October for any host west of
    // Greenwich, which is most of the Americas.
    const source = serializeCalendar({
      events: [event({ timing: { kind: 'allDay', startDate: '2026-10-03', endDate: '2026-10-04' } })],
    });

    expect(parseCalendar(source).events[0]?.timing).toEqual({
      kind: 'allDay',
      startDate: '2026-10-03',
      endDate: '2026-10-04',
    });
  });

  it('round-trips text that needs escaping', () => {
    const title = 'Budget: Q3, phase 2; draft \\ final';
    const source = serializeCalendar({ events: [event({ title, description: 'line one\nline two' })] });
    const parsed = parseCalendar(source).events[0];

    expect(parsed?.title).toBe(title);
    expect(parsed?.description).toBe('line one\nline two');
  });

  it('recovers a folded calendar name', () => {
    const name = `Operations ${'and maintenance '.repeat(6)}calendar`;
    const parsed = parseCalendar(serializeCalendar({ events: [event()], name }));
    expect(parsed.name).toBe(name);
  });

  it('skips a malformed VEVENT rather than losing the whole feed', () => {
    // One broken event in a third-party feed must not cost the other 400.
    const source = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:no-start@test',
      'SUMMARY:Missing DTSTART',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:fine@test',
      'DTSTART;VALUE=DATE:20261003',
      'DTEND;VALUE=DATE:20261004',
      'SUMMARY:Fine',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');

    const events = parseCalendar(source).events;
    expect(events).toHaveLength(1);
    expect(events[0]?.uid).toBe('fine@test');
  });
});

describe('round-trip reaches a fixed point over the conformance corpus', () => {
  interface Fixture {
    name: string;
    timing: EventTiming;
    recurrence?: string;
    exceptionDates?: string[];
    renderTimeZone?: string;
    window: QueryWindow;
  }

  const corpus = fixtures as Fixture[];

  const asEvent = (fixture: Fixture, index: number): CalendarEvent => {
    const built: CalendarEvent = {
      id: `evt-${index}` as EventId,
      calendarId: 'cal-1' as CalendarId,
      tenantId: 'tenant-1' as TenantId,
      uid: `fixture-${index}@gnomon.test`,
      title: fixture.name,
      timing: fixture.timing,
    };
    if (fixture.recurrence !== undefined) built.recurrence = fixture.recurrence;
    if (fixture.exceptionDates !== undefined) built.exceptionDates = fixture.exceptionDates;
    return built;
  };

  it('serialise -> parse -> serialise is stable for the whole corpus at once', () => {
    const events = corpus.map(asEvent);
    const first = serializeCalendar({ events, name: 'Corpus' });

    const reparsed = parseCalendar(first).events.map((parsed, index) => ({
      ...parsed,
      id: `evt-${index}` as EventId,
      calendarId: 'cal-1' as CalendarId,
      tenantId: 'tenant-1' as TenantId,
    }));

    expect(reparsed).toHaveLength(events.length);
    expect(serializeCalendar({ events: reparsed, name: 'Corpus' })).toBe(first);
  });

  for (const [index, fixture] of corpus.entries()) {
    it(`preserves expansion through a round trip: ${fixture.name}`, () => {
      // The strongest property available: a round trip must not change what
      // the event MEANS. Byte stability alone would still allow a systematic
      // misreading to survive, so this compares expanded occurrences.
      const original = asEvent(fixture, index);
      const source = serializeCalendar({ events: [original] });

      const parsed = parseCalendar(source).events[0];
      expect(parsed, `no event survived the round trip`).toBeDefined();

      const restored: CalendarEvent = {
        ...(parsed as Omit<CalendarEvent, 'id' | 'calendarId' | 'tenantId'>),
        id: original.id,
        calendarId: original.calendarId,
        tenantId: original.tenantId,
      };

      const options = { renderTimeZone: fixture.renderTimeZone ?? 'UTC' };
      expect(expandEvent(restored, fixture.window, options)).toEqual(
        expandEvent(original, fixture.window, options),
      );
    });
  }
});
