import { describe, expect, it } from 'vitest';
import { expandEvent, expandEvents } from '../src/expand.js';
import { TooManyOccurrencesError, WindowTooLargeError } from '../src/window.js';
import type {
  CalendarEvent,
  CalendarId,
  EventId,
  EventTiming,
  RecurrenceOverride,
  TenantId,
} from '../src/types.js';

const NY = 'America/New_York';

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1' as EventId,
    calendarId: 'cal-1' as CalendarId,
    tenantId: 'tenant-1' as TenantId,
    uid: 'evt-1@gnomon.test',
    title: 'Standup',
    timing: {
      kind: 'timed',
      start: '2026-06-01T09:00:00',
      end: '2026-06-01T09:15:00',
      timeZone: NY,
    },
    recurrence: 'FREQ=DAILY;COUNT=5',
    ...overrides,
  };
}

const WEEK = { from: '2026-06-01T00:00:00Z', to: '2026-06-08T00:00:00Z' };
const opts = { renderTimeZone: NY };

/** 09:00 New York on the given June day, as the instant used for RECURRENCE-ID. */
const recurrenceIdFor = (day: number) =>
  `2026-06-0${day}T13:00:00Z`;

describe('expansion guards', () => {
  it('rejects an over-wide window before doing any work', () => {
    expect(() =>
      expandEvent(event(), { from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, opts),
    ).toThrow(WindowTooLargeError);
  });

  it('caps occurrence count independently of the window cap', () => {
    // 100 days is well inside MAX_WINDOW_DAYS, and MINUTELY inside it is
    // ~144,000 occurrences. The day cap alone is not a DoS control.
    expect(() =>
      expandEvent(
        event({ recurrence: 'FREQ=MINUTELY' }),
        { from: '2026-06-01T00:00:00Z', to: '2026-09-09T00:00:00Z' },
        opts,
      ),
    ).toThrow(TooManyOccurrencesError);
  });

  it('honours a caller-supplied lower cap', () => {
    expect(() => expandEvent(event(), WEEK, { ...opts, maxOccurrences: 2 })).toThrow(
      TooManyOccurrencesError,
    );
  });

  it('caps across the whole request, not per event', () => {
    // Three events of five occurrences each must trip a cap of six.
    const events = [
      event({ id: 'a' as EventId }),
      event({ id: 'b' as EventId }),
      event({ id: 'c' as EventId }),
    ];
    expect(() => expandEvents(events, WEEK, { ...opts, maxOccurrences: 6 })).toThrow(
      TooManyOccurrencesError,
    );
  });
});

describe('non-recurring events', () => {
  it('produces exactly one occurrence with no recurrence id', () => {
    const [occurrence, ...rest] = expandEvent(
      event({ recurrence: undefined as unknown as string }),
      WEEK,
      opts,
    );
    expect(rest).toHaveLength(0);
    expect(occurrence?.recurrenceId).toBeUndefined();
    expect(occurrence?.isOverride).toBe(false);
  });
});

describe('recurrence overrides', () => {
  it('applies a patched title without moving the instance', () => {
    const override: RecurrenceOverride = {
      eventId: 'evt-1' as EventId,
      recurrenceId: recurrenceIdFor(3),
      patch: { title: 'Standup (extended)' },
    };

    const occurrences = expandEvent(event(), WEEK, { ...opts, overrides: [override] });
    const patched = occurrences.find((o) => o.recurrenceId === recurrenceIdFor(3));

    expect(occurrences).toHaveLength(5);
    expect(patched?.title).toBe('Standup (extended)');
    expect(patched?.isOverride).toBe(true);
    // Siblings are untouched.
    expect(occurrences.filter((o) => o.title === 'Standup')).toHaveLength(4);
  });

  it('omits a cancelled instance', () => {
    const override: RecurrenceOverride = {
      eventId: 'evt-1' as EventId,
      recurrenceId: recurrenceIdFor(3),
      patch: null,
    };

    const occurrences = expandEvent(event(), WEEK, { ...opts, overrides: [override] });

    expect(occurrences).toHaveLength(4);
    expect(occurrences.some((o) => o.recurrenceId === recurrenceIdFor(3))).toBe(false);
  });

  it('includes an instance an override moved INTO the window from outside it', () => {
    // The 12 June instance is outside the queried week. Rescheduling it to
    // 4 June must make it appear -- otherwise moving an event into view
    // makes it vanish instead.
    const moved: EventTiming = {
      kind: 'timed',
      start: '2026-06-04T15:00:00',
      end: '2026-06-04T15:30:00',
      timeZone: NY,
    };
    const override: RecurrenceOverride = {
      eventId: 'evt-1' as EventId,
      recurrenceId: '2026-06-12T13:00:00Z',
      patch: { timing: moved },
    };

    const occurrences = expandEvent(
      event({ recurrence: 'FREQ=DAILY;COUNT=20' }),
      WEEK,
      { ...opts, overrides: [override] },
    );

    const relocated = occurrences.find((o) => o.recurrenceId === '2026-06-12T13:00:00Z');
    expect(relocated).toBeDefined();
    expect(relocated?.isOverride).toBe(true);
    expect(relocated?.timing).toEqual(moved);
  });

  it('excludes an instance an override moved OUT of the window', () => {
    const override: RecurrenceOverride = {
      eventId: 'evt-1' as EventId,
      recurrenceId: recurrenceIdFor(3),
      patch: {
        timing: {
          kind: 'timed',
          start: '2026-07-20T09:00:00',
          end: '2026-07-20T09:15:00',
          timeZone: NY,
        },
      },
    };

    const occurrences = expandEvent(event(), WEEK, { ...opts, overrides: [override] });

    expect(occurrences).toHaveLength(4);
    expect(occurrences.some((o) => o.recurrenceId === recurrenceIdFor(3))).toBe(false);
  });

  it('resolves conflicting overrides for one instance by SEQUENCE', () => {
    const overrides: RecurrenceOverride[] = [
      {
        eventId: 'evt-1' as EventId,
        recurrenceId: recurrenceIdFor(3),
        patch: { title: 'first revision' },
        sequence: 1,
      },
      {
        eventId: 'evt-1' as EventId,
        recurrenceId: recurrenceIdFor(3),
        patch: { title: 'second revision' },
        sequence: 2,
      },
    ];

    const occurrences = expandEvent(event(), WEEK, { ...opts, overrides });
    const patched = occurrences.find((o) => o.recurrenceId === recurrenceIdFor(3));

    expect(patched?.title).toBe('second revision');
  });

  it('treats an absent SEQUENCE as lower than an explicit one', () => {
    const overrides: RecurrenceOverride[] = [
      {
        eventId: 'evt-1' as EventId,
        recurrenceId: recurrenceIdFor(3),
        patch: { title: 'explicit revision' },
        sequence: 1,
      },
      {
        eventId: 'evt-1' as EventId,
        recurrenceId: recurrenceIdFor(3),
        patch: { title: 'undeclared revision' },
      },
    ];

    const occurrences = expandEvent(event(), WEEK, { ...opts, overrides });
    expect(occurrences.find((o) => o.recurrenceId === recurrenceIdFor(3))?.title).toBe(
      'explicit revision',
    );
  });
});

describe('expandEvents', () => {
  it('returns occurrences from all events sorted by start', () => {
    const morning = event({
      id: 'morning' as EventId,
      timing: { kind: 'timed', start: '2026-06-01T09:00:00', end: '2026-06-01T09:15:00', timeZone: NY },
      recurrence: 'FREQ=DAILY;COUNT=2',
    });
    const evening = event({
      id: 'evening' as EventId,
      timing: { kind: 'timed', start: '2026-06-01T18:00:00', end: '2026-06-01T18:15:00', timeZone: NY },
      recurrence: 'FREQ=DAILY;COUNT=2',
    });

    const starts = expandEvents([evening, morning], WEEK, opts).map((o) =>
      o.timing.kind === 'timed' ? o.timing.start : o.timing.startDate,
    );

    expect(starts).toEqual([
      '2026-06-01T09:00:00',
      '2026-06-01T18:00:00',
      '2026-06-02T09:00:00',
      '2026-06-02T18:00:00',
    ]);
  });

  it('mixes all-day and timed events in one ordering', () => {
    const timed = event({ id: 'timed' as EventId, recurrence: 'FREQ=DAILY;COUNT=1' });
    const allDay = event({
      id: 'allday' as EventId,
      timing: { kind: 'allDay', startDate: '2026-06-01', endDate: '2026-06-02' },
      recurrence: undefined as unknown as string,
    });

    const occurrences = expandEvents([timed, allDay], WEEK, opts);
    expect(occurrences).toHaveLength(2);
    // The all-day date sorts before the timed wall-clock string on the same
    // day, which is the conventional "all-day first" reading order.
    expect(occurrences[0]?.timing.kind).toBe('allDay');
  });
});
