import type { CalendarEvent } from '@gnomon/core';

/**
 * Reconciling a polled ICS feed against what we already stored (phase 7.2).
 *
 * Pure, and separated from the polling for that reason: the diff is where the
 * data-loss bugs live, and it can be tested exhaustively without a network or
 * a database.
 *
 * MATCHED BY `uid`, NOT BY OUR PRIMARY KEY. That is the whole reason phase 1
 * kept `uid` distinct from `id`: the remote feed knows nothing about our ids,
 * and a UID is the only stable identity RFC 5545 gives us across polls.
 */

export interface ReconcileInput {
  /** Events parsed from the feed just fetched. */
  incoming: readonly IncomingEvent[];
  /** What this source produced last time, as stored. */
  existing: readonly StoredEvent[];
}

export type IncomingEvent = Omit<CalendarEvent, 'id' | 'tenantId' | 'calendarId'>;

export interface StoredEvent {
  id: string;
  uid: string;
  /** Used to decide whether anything actually changed. */
  fingerprint: string;
}

export interface ReconcilePlan {
  create: IncomingEvent[];
  update: { id: string; event: IncomingEvent }[];
  /** Ids to remove: present last poll, absent now. */
  remove: string[];
  unchanged: number;
}

/**
 * Computes what to do, without doing any of it.
 *
 * The `unchanged` count is returned rather than discarded because it is the
 * number that tells an operator whether polling is doing anything: a feed
 * reporting hundreds of updates every poll has a fingerprint problem, not a
 * busy calendar.
 */
export function reconcile(input: ReconcileInput): ReconcilePlan {
  const existingByUid = new Map(input.existing.map((event) => [event.uid, event]));
  const seen = new Set<string>();

  const plan: ReconcilePlan = { create: [], update: [], remove: [], unchanged: 0 };

  for (const event of input.incoming) {
    // A feed repeating a UID is malformed. Taking the first occurrence keeps
    // the poll deterministic; taking the last would make the stored result
    // depend on parse order.
    if (seen.has(event.uid)) continue;
    seen.add(event.uid);

    const current = existingByUid.get(event.uid);
    if (!current) {
      plan.create.push(event);
    } else if (current.fingerprint !== fingerprint(event)) {
      plan.update.push({ id: current.id, event });
    } else {
      plan.unchanged += 1;
    }
  }

  for (const stored of input.existing) {
    if (!seen.has(stored.uid)) plan.remove.push(stored.id);
  }

  return plan;
}

/**
 * A stable digest of everything we store about an event.
 *
 * Compared instead of the fields themselves so that "did this change?" is one
 * cheap comparison rather than a deep equality that has to be kept in step
 * with the schema. Key order is fixed by construction, because
 * `JSON.stringify` over an object built elsewhere would make the fingerprint
 * depend on property insertion order and every poll would look like a change.
 */
export function fingerprint(event: IncomingEvent): string {
  const timing =
    event.timing.kind === 'timed'
      ? ['timed', event.timing.start, event.timing.end, event.timing.timeZone]
      : ['allDay', event.timing.startDate, event.timing.endDate];

  return JSON.stringify([
    event.uid,
    event.title,
    event.description ?? '',
    event.location ?? '',
    event.status ?? '',
    event.recurrence ?? '',
    // Sorted: a feed reordering its EXDATEs is not a change to the event.
    [...(event.exceptionDates ?? [])].sort(),
    event.sequence ?? 0,
    timing,
  ]);
}

/**
 * How long to wait before polling a failing source again.
 *
 * Exponential with a ceiling, because a source that has been broken for a day
 * is unlikely to be fixed in the next five minutes, and hammering it helps
 * nobody. The ceiling exists so a source that comes back is noticed within a
 * few hours rather than a few days.
 *
 * Jitter is applied by the caller from its own clock; this function stays
 * pure so it can be tested.
 */
export function backoffSeconds(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const base = 5 * 60; // the normal poll interval
  const ceiling = 6 * 60 * 60;
  return Math.min(base * 2 ** Math.min(consecutiveFailures - 1, 10), ceiling);
}

/**
 * When a source has failed often enough that it should be surfaced rather
 * than retried quietly for ever.
 *
 * Not a hard stop -- polling continues at the ceiling interval -- but the
 * operator-facing state says "this is broken" rather than "last error was a
 * while ago", which is the difference between a source someone fixes and one
 * that rots.
 */
export const FAILURE_ALERT_THRESHOLD = 5;
