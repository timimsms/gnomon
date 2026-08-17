import { describe, expect, it } from 'vitest';
import corpus from '../../../packages/core/test/fixtures/recurrence.json' with { type: 'json' };
import { Temporal, expandEvent } from '@gnomon/core';
import type {
  CalendarEvent,
  CalendarId,
  EventId,
  EventTiming,
  QueryWindow,
  TenantId,
} from '@gnomon/core';
import { computeSearchSpan, fromEventRow, toEventRow } from '../src/db/events.js';

const TENANT = 'acme' as TenantId;
const CAL = '11111111-1111-4111-8111-111111111111' as CalendarId;
const ID = '22222222-2222-4222-8222-222222222222' as EventId;

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: ID,
    tenantId: TENANT,
    calendarId: CAL,
    uid: 'evt@gnomon.test',
    title: 'Standup',
    timing: {
      kind: 'timed',
      start: '2026-06-01T09:00:00',
      end: '2026-06-01T09:15:00',
      timeZone: 'America/New_York',
    },
    ...overrides,
  };
}

describe('round-trips through the row representation', () => {
  const cases: [string, Partial<CalendarEvent>][] = [
    ['a bare timed event', {}],
    ['a recurring timed event', { recurrence: 'FREQ=DAILY;COUNT=5' }],
    [
      'an all-day event',
      { timing: { kind: 'allDay', startDate: '2026-10-03', endDate: '2026-10-04' } },
    ],
    [
      'a multi-day all-day event with a rule',
      {
        timing: { kind: 'allDay', startDate: '2026-06-01', endDate: '2026-06-05' },
        recurrence: 'FREQ=WEEKLY;COUNT=3',
      },
    ],
    [
      'an event carrying every optional field',
      {
        description: 'Daily sync',
        location: 'Room 2',
        status: 'tentative',
        recurrence: 'FREQ=DAILY;UNTIL=20260630T130000Z',
        exceptionDates: ['2026-06-02T13:00:00Z'],
        sequence: 3,
      },
    ],
  ];

  for (const [name, overrides] of cases) {
    it(name, () => {
      const original = event(overrides);
      expect(fromEventRow(toEventRow(original))).toEqual(original);
    });
  }

  it('distinguishes an absent optional field from an explicit undefined', () => {
    // exactOptionalPropertyTypes makes these different types, and they
    // serialise differently over the wire.
    const restored = fromEventRow(toEventRow(event()));
    expect('description' in restored).toBe(false);
    expect('recurrence' in restored).toBe(false);
  });

  it('writes null rather than the other kind of timing columns', () => {
    const timed = toEventRow(event());
    expect([timed.startDate, timed.endDate]).toEqual([null, null]);

    const allDay = toEventRow(
      event({ timing: { kind: 'allDay', startDate: '2026-10-03', endDate: '2026-10-04' } }),
    );
    // The CHECK constraints reject anything else, so a row that fails this
    // would be refused by the database at insert time.
    expect([allDay.startLocal, allDay.endLocal, allDay.timeZone]).toEqual([null, null, null]);
  });
});

// ---------------------------------------------------------------------------
// The span invariant
// ---------------------------------------------------------------------------

/** `[lower,upper)` -> bounds, with an empty upper meaning unbounded. */
function parseSpan(span: string): { lower: Temporal.Instant; upper: Temporal.Instant | null } {
  const match = /^\[([^,]+),([^)]*)\)$/.exec(span);
  if (!match) throw new Error(`unparseable span: ${span}`);
  return {
    lower: Temporal.Instant.from(match[1] as string),
    upper: match[2] ? Temporal.Instant.from(match[2]) : null,
  };
}

/** Every instant an occurrence occupies, rendered in `zone`. */
function occurrenceBounds(timing: EventTiming, zone: string): [Temporal.Instant, Temporal.Instant] {
  if (timing.kind === 'timed') {
    return [
      Temporal.PlainDateTime.from(timing.start).toZonedDateTime(timing.timeZone).toInstant(),
      Temporal.PlainDateTime.from(timing.end).toZonedDateTime(timing.timeZone).toInstant(),
    ];
  }
  return [
    Temporal.PlainDate.from(timing.startDate).toZonedDateTime({ timeZone: zone }).toInstant(),
    Temporal.PlainDate.from(timing.endDate).toZonedDateTime({ timeZone: zone }).toInstant(),
  ];
}

/**
 * The extremes of IANA offsets. An all-day span must hold for BOTH, because a
 * floating date is resolved against the caller's rendering zone rather than
 * anything we stored.
 */
const EXTREME_ZONES = ['Pacific/Kiritimati', 'Etc/GMT+12', 'UTC'] as const;

describe('search_span is a conservative superset of every occurrence', () => {
  interface Fixture {
    name: string;
    timing: EventTiming;
    recurrence?: string;
    exceptionDates?: string[];
    window: QueryWindow;
  }

  const fixtures = corpus as Fixture[];

  it('is running against the real phase 1 corpus', () => {
    expect(fixtures.length).toBeGreaterThan(15);
  });

  for (const [index, fixture] of fixtures.entries()) {
    it(`contains every occurrence of: ${fixture.name}`, () => {
      // The invariant that matters: never NARROWER than reality. A too-wide
      // span costs one wasted expansion; a too-narrow one silently drops
      // events from a query and nothing downstream can detect it.
      const built: CalendarEvent = event({
        id: `evt-${index}` as EventId,
        timing: fixture.timing,
        ...(fixture.recurrence !== undefined ? { recurrence: fixture.recurrence } : {}),
        ...(fixture.exceptionDates !== undefined ? { exceptionDates: fixture.exceptionDates } : {}),
      });

      const { lower, upper } = parseSpan(computeSearchSpan(built));

      for (const zone of EXTREME_ZONES) {
        for (const occurrence of expandEvent(built, fixture.window, { renderTimeZone: zone })) {
          const [start, end] = occurrenceBounds(occurrence.timing, zone);

          expect(
            Temporal.Instant.compare(start, lower),
            `occurrence starting ${start.toString()} (rendered in ${zone}) is before the span lower bound ${lower.toString()}`,
          ).toBeGreaterThanOrEqual(0);

          if (upper) {
            expect(
              Temporal.Instant.compare(end, upper),
              `occurrence ending ${end.toString()} (rendered in ${zone}) is past the span upper bound ${upper.toString()}`,
            ).toBeLessThanOrEqual(0);
          }
        }
      }
    });
  }
});

describe('search_span bounds', () => {
  it('is finite for a non-recurring event', () => {
    expect(computeSearchSpan(event())).toBe('[2026-06-01T13:00:00Z,2026-06-01T13:15:00Z)');
  });

  it('is never an EMPTY range, even for a zero-duration event', () => {
    // `[t,t)` is an empty tstzrange in Postgres, and an empty range overlaps
    // NOTHING -- so the GiST pre-filter would silently drop the event and it
    // would be missing from every query, with no error anywhere. Found via the
    // phase 1 corpus fixture for a zero-length occurrence once the API started
    // querying through the index.
    const instant = event({
      timing: { kind: 'timed', start: '2026-06-02T00:00:00', end: '2026-06-02T00:00:00', timeZone: 'UTC' },
    });
    const { lower, upper } = parseSpan(computeSearchSpan(instant));

    expect(upper).not.toBeNull();
    expect(Temporal.Instant.compare(upper as Temporal.Instant, lower)).toBe(1);
  });

  it('is unbounded for a rule with no UNTIL', () => {
    expect(computeSearchSpan(event({ recurrence: 'FREQ=DAILY' }))).toMatch(/,\)$/);
  });

  it('is unbounded for a COUNT-limited rule', () => {
    // Tightenable by expanding at write time, and deliberately not done:
    // a dense rule would make writes expensive to save a read the GiST index
    // already makes cheap. Correct, just less selective.
    expect(computeSearchSpan(event({ recurrence: 'FREQ=DAILY;COUNT=5' }))).toMatch(/,\)$/);
  });

  it('is bounded, with slack, for a rule with UNTIL', () => {
    const { upper } = parseSpan(
      computeSearchSpan(event({ recurrence: 'FREQ=DAILY;UNTIL=20260630T130000Z' })),
    );
    expect(upper).not.toBeNull();
    // Past UNTIL, because the last occurrence still has a duration and that
    // duration wobbles by an hour across a DST boundary.
    expect(Temporal.Instant.compare(upper as Temporal.Instant, Temporal.Instant.from('2026-06-30T13:00:00Z'))).toBe(1);
  });

  it('treats a date-valued UNTIL as bounded', () => {
    const { upper } = parseSpan(computeSearchSpan(event({ recurrence: 'FREQ=DAILY;UNTIL=20260630' })));
    expect(upper).not.toBeNull();
  });

  it('falls back to unbounded when UNTIL is unparseable', () => {
    // A malformed rule must never produce a NARROW span -- that would lose
    // events silently. Unbounded is the conservative reading.
    expect(computeSearchSpan(event({ recurrence: 'FREQ=DAILY;UNTIL=next-tuesday' }))).toMatch(/,\)$/);
  });

  it('pads an all-day span past every possible rendering zone', () => {
    const { lower, upper } = parseSpan(
      computeSearchSpan(
        event({ timing: { kind: 'allDay', startDate: '2026-10-03', endDate: '2026-10-04' } }),
      ),
    );
    // 3 Oct begins earliest in +14 and ends latest in -12; the pad covers both.
    expect(lower.toString()).toBe('2026-10-02T10:00:00Z');
    expect(upper?.toString()).toBe('2026-10-04T14:00:00Z');
  });

  it('does not depend on the calendar timezone', () => {
    // Correcting a misconfigured calendars.time_zone must not invalidate
    // stored spans -- that coupling is why ADR-0005 rejected zone-anchored
    // storage in the first place.
    const allDay = event({ timing: { kind: 'allDay', startDate: '2026-10-03', endDate: '2026-10-04' } });
    expect(computeSearchSpan(allDay)).toBe(computeSearchSpan({ ...allDay }));
  });
});
