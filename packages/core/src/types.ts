/**
 * Core domain types.
 *
 * Deliberately I/O-free: this package must run identically on the server
 * (native Temporal, Node 26+) and in the browser (temporal-polyfill).
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
   * Default timezone for the calendar. Events may override.
   * Used to anchor all-day events -- see O5.
   */
  timeZone: TimeZoneId;
  colour?: string;
}

/**
 * A stored event. This is the authoring-time record, NOT a materialised
 * occurrence. Recurring events are stored once with an RRULE and expanded
 * on read within a bounded window.
 */
export interface CalendarEvent {
  id: EventId;
  calendarId: CalendarId;
  tenantId: TenantId;
  title: string;
  description?: string;
  location?: string;

  /** ISO 8601 instant or plain date-time, depending on `allDay`. */
  start: string;
  end: string;
  timeZone: TimeZoneId;

  /**
   * TODO(O5): all-day semantics are UNRESOLVED. Two candidate models:
   *
   *   (a) Floating date  -- an all-day event is a PlainDate with no zone.
   *                         "October 3rd" is October 3rd everywhere.
   *   (b) Zone-anchored  -- an all-day event is a ZonedDateTime range
   *                         anchored to the calendar's timezone.
   *
   * (a) matches RFC 5545 DATE-valued DTSTART and user intuition for
   * holidays and birthdays. (b) is easier to query against a tstzrange
   * index and easier to reconcile with timed events in the same view.
   *
   * This MUST be resolved inside Phase 1 -- it is a schema decision, and
   * migrating stored events between models after launch is painful.
   */
  allDay: boolean;

  /** Absent for single events. */
  recurrence?: RRuleText;
  /** RFC 5545 EXDATE values. */
  exceptionDates?: readonly string[];
}

/**
 * A single materialised instance of an event within a query window.
 * Produced by expansion; never persisted in Phase 1 (see O4).
 */
export interface EventOccurrence {
  eventId: EventId;
  calendarId: CalendarId;
  /** RFC 5545 RECURRENCE-ID: identifies which instance this is. */
  recurrenceId?: string;
  title: string;
  start: string;
  end: string;
  timeZone: TimeZoneId;
  allDay: boolean;
  /** True when this instance was modified away from the rule. */
  isOverride: boolean;
}

/** A modification to one instance of a recurring series. */
export interface RecurrenceOverride {
  eventId: EventId;
  recurrenceId: string;
  /** Null title means the instance is cancelled. */
  patch: Partial<Pick<CalendarEvent, 'title' | 'start' | 'end' | 'location' | 'description'>> | null;
}

/** An inclusive-start, exclusive-end query window. */
export interface QueryWindow {
  from: string;
  to: string;
}
