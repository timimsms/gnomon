/**
 * Core domain types.
 *
 * Deliberately I/O-free: this package must run identically on the server and
 * in the browser (see L9 and ADR-0006).
 */

export type TenantId = string & { readonly __brand: 'TenantId' };
export type CalendarId = string & { readonly __brand: 'CalendarId' };
export type EventId = string & { readonly __brand: 'EventId' };

/** IANA timezone identifier, e.g. "America/New_York". */
export type TimeZoneId = string;

/** RFC 5545 RRULE property value, stored verbatim as text. */
export type RRuleText = string;

export interface Calendar {
  id: CalendarId;
  tenantId: TenantId;
  name: string;
  /**
   * Default timezone for the calendar. Timed events may override it.
   *
   * Note that per ADR-0005 this does NOT anchor all-day events -- those are
   * floating dates. It is used to derive the coarse `tstzrange` index and as
   * a fallback rendering zone.
   */
  timeZone: TimeZoneId;
  colour?: string;
}

/**
 * When an event happens.
 *
 * A discriminated union rather than an `allDay: boolean` alongside optional
 * time fields, because the boolean form permits states with no meaning -- an
 * all-day event carrying a time and a timezone -- and pushes interpretation
 * onto every consumer. See ADR-0005.
 */
export type EventTiming =
  | {
      kind: 'timed';
      /** RFC 3339 / ISO 8601 local date-time, e.g. "2026-03-08T09:00:00". */
      start: string;
      /** Exclusive end, same form as `start`. */
      end: string;
      /** The zone `start` and `end` are wall-clock times in. */
      timeZone: TimeZoneId;
    }
  | {
      kind: 'allDay';
      /** ISO 8601 calendar date, e.g. "2026-10-03". No zone: it is this date everywhere. */
      startDate: string;
      /**
       * EXCLUSIVE end date, matching RFC 5545 DTEND for DATE values.
       * A single-day event on 2026-10-03 has endDate "2026-10-04".
       *
       * Counter-intuitive, and it removes the off-by-one that otherwise
       * appears in every all-day event and every ICS round trip.
       */
      endDate: string;
    };

export type EventStatus = 'confirmed' | 'tentative' | 'cancelled';

/**
 * A stored event -- the authoring-time record, NOT a materialised occurrence.
 * Recurring events are stored once and expanded on read (ADR-0007).
 */
export interface CalendarEvent {
  id: EventId;
  calendarId: CalendarId;
  tenantId: TenantId;

  /**
   * RFC 5545 UID. Distinct from `id` on purpose: an ICS UID must survive a
   * round trip and must not be assumed equal to our primary key, or ingesting
   * the same feed into two calendars collides (Phase 7.2 reconciles on this).
   */
  uid: string;

  title: string;
  description?: string;
  location?: string;
  status?: EventStatus;

  timing: EventTiming;

  /** Absent for single events. RFC 5545 RRULE value, without the "RRULE:" prefix. */
  recurrence?: RRuleText;

  /**
   * RFC 5545 EXDATE values. Matched by instant, not by string form -- the same
   * moment written in two zones must exclude the same occurrence.
   */
  exceptionDates?: readonly string[];

  /**
   * RFC 5545 SEQUENCE. Used to resolve which of two conflicting overrides for
   * the same RECURRENCE-ID wins.
   */
  sequence?: number;
}

/**
 * A single instance of an event within a query window.
 * Produced by expansion; never persisted in v0.1 (ADR-0007).
 */
export interface EventOccurrence {
  eventId: EventId;
  calendarId: CalendarId;

  /**
   * RFC 5545 RECURRENCE-ID: identifies which instance of the series this is,
   * as the ORIGINAL start the rule produced. Absent for non-recurring events.
   *
   * It stays pinned to the original even when an override moves the instance,
   * because that is what identifies the instance across edits.
   */
  recurrenceId?: string;

  title: string;
  description?: string;
  location?: string;
  status?: EventStatus;

  timing: EventTiming;

  /** True when this instance was modified away from the rule by an override. */
  isOverride: boolean;
}

/** A modification to one instance of a recurring series. */
export interface RecurrenceOverride {
  eventId: EventId;
  /** The original rule-produced start this override replaces. */
  recurrenceId: string;
  /**
   * `null` means the instance is cancelled -- distinct from an EXDATE, which
   * removes it from the series entirely. A cancelled instance is still part
   * of the series and still round-trips through ICS.
   */
  patch: EventPatch | null;
  sequence?: number;
}

export type EventPatch = Partial<
  Pick<CalendarEvent, 'title' | 'description' | 'location' | 'status' | 'timing'>
>;

/** An inclusive-start, exclusive-end query window, as ISO 8601 instants. */
export interface QueryWindow {
  from: string;
  to: string;
}
