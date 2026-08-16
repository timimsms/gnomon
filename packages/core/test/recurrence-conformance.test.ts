import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/recurrence.json' with { type: 'json' };
import { expandEvent } from '../src/expand.js';
import { Temporal } from '../src/temporal.js';
import type {
  CalendarEvent,
  CalendarId,
  EventId,
  EventTiming,
  QueryWindow,
  TenantId,
} from '../src/types.js';

/**
 * The recurrence conformance corpus.
 *
 * Expected values are derived from RFC 5545 and from reasoning about the
 * calendar, NEVER from this implementation's output. A corpus regenerated
 * from the code it tests proves only that the code is deterministic.
 *
 * Cases carrying a `regression` note record a defect in rrule-temporal 2.2.0
 * that `expand.ts` corrects. If one of those starts failing after a dependency
 * bump, the library was fixed upstream and our correction may now be
 * double-applied -- check before deleting anything.
 *
 * Cases carrying a `decision` note cover behaviour RFC 5545 leaves
 * underspecified. There the fixture records our choice and why, so that
 * changing it is a deliberate act rather than an accident.
 */

interface Fixture {
  name: string;
  why: string;
  decision?: string;
  regression?: string;
  rfc?: string;
  timing: EventTiming;
  recurrence?: string;
  exceptionDates?: string[];
  renderTimeZone?: string;
  window: QueryWindow;
  expect: string[];
  expectInstants?: string[];
  expectEnds?: string[];
}

const startOf = (timing: EventTiming) =>
  timing.kind === 'timed' ? timing.start : timing.startDate;

const endOf = (timing: EventTiming) => (timing.kind === 'timed' ? timing.end : timing.endDate);

function eventFrom(fixture: Fixture): CalendarEvent {
  const event: CalendarEvent = {
    id: 'evt-fixture' as EventId,
    calendarId: 'cal-fixture' as CalendarId,
    tenantId: 'tenant-fixture' as TenantId,
    uid: 'fixture@gnomon.test',
    title: 'Fixture',
    timing: fixture.timing,
  };
  if (fixture.recurrence !== undefined) event.recurrence = fixture.recurrence;
  if (fixture.exceptionDates !== undefined) event.exceptionDates = fixture.exceptionDates;
  return event;
}

describe('recurrence conformance corpus', () => {
  it('has no duplicate fixture names', () => {
    const names = (fixtures as Fixture[]).map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('documents why every fixture exists', () => {
    // A fixture without a rationale becomes unmaintainable the first time it
    // fails: nobody can tell whether the expectation or the code is wrong.
    for (const fixture of fixtures as Fixture[]) {
      expect(fixture.why, `fixture "${fixture.name}" has no rationale`).toBeTruthy();
    }
  });

  for (const fixture of fixtures as Fixture[]) {
    it(fixture.name, () => {
      const occurrences = expandEvent(eventFrom(fixture), fixture.window, {
        renderTimeZone: fixture.renderTimeZone ?? 'UTC',
      });

      expect(occurrences.map((o) => startOf(o.timing))).toEqual(fixture.expect);

      if (fixture.expectEnds) {
        expect(occurrences.map((o) => endOf(o.timing))).toEqual(fixture.expectEnds);
      }

      if (fixture.expectInstants) {
        const instants = occurrences.map((o) => {
          if (o.timing.kind !== 'timed') throw new Error('expectInstants needs timed occurrences');
          return Temporal.PlainDateTime.from(o.timing.start)
            .toZonedDateTime(o.timing.timeZone)
            .toInstant()
            .toString();
        });
        expect(instants).toEqual(fixture.expectInstants);
      }
    });
  }
});
