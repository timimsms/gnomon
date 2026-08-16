# ADR-0005: All-day events are floating dates

**Status:** Accepted
**Date:** 2026-08-10
**Relates to:** O5 (closed), L6, Phase 1
**Supersedes:** the `TODO(O5)` in `packages/core/src/types.ts`

## Context

An all-day event — a public holiday, a birthday, a bin collection, a move-in
date — has no time component. The question is whether it also has a timezone.

Two models were on the table:

**(a) Floating date.** The event is a `PlainDate`. "October 3rd" is October 3rd
everywhere. This is what RFC 5545 means by a `DATE`-valued `DTSTART`.

**(b) Zone-anchored.** The event is a `ZonedDateTime` range anchored to the
calendar's timezone — `2026-10-03T00:00:00[America/Denver]` through the
following midnight.

(b) is materially easier to implement. Every event becomes a single
`tstzrange`, one GiST index answers every overlap query, and all-day and timed
events sort against each other without special cases.

This decision had to be made inside Phase 1, before the first Drizzle
migration, because the two models are not inter-convertible after the fact: the
information required to migrate (a) → (b) or (b) → (a) is exactly the
information the losing model discarded.

## Decision

**All-day events are floating dates.**

`CalendarEvent` carries a discriminated union rather than a boolean flag:

```ts
type EventTiming =
  | { kind: 'timed';  start: string; end: string; timeZone: TimeZoneId }
  | { kind: 'allDay'; startDate: string; endDate: string }
```

`endDate` is **exclusive**, matching RFC 5545 `DTEND` for `DATE` values. A
single-day all-day event on 2026-10-03 has `endDate: '2026-10-04'`. This is
counter-intuitive and it removes the off-by-one that otherwise appears in
every all-day event, every ICS round trip, and every renderer integration.

A discriminated union rather than `allDay: boolean` because the boolean version
permits states that have no meaning — an all-day event carrying a time
component and a timezone — and pushes the interpretation of those fields onto
every consumer. The union makes the invalid state unrepresentable.

**The indexing advantage of (b) is purchased without adopting its semantics.**
All-day events are stored as `DATE` and a `tstzrange` is *derived* against the
calendar timezone for indexing only, as a coarse pre-filter. Exact boundaries
are applied after the index scan. The query plan is (b)'s; the meaning is (a)'s.

## Consequences

- A tenant that corrects a misconfigured timezone does not silently move every
  historical all-day event. Under (b) it would, and there would be no record
  that it had happened.
- A viewer in Tokyo sees a US holiday on the correct date. Under (b), a
  midnight-anchored Denver event lands at 15:00 the same day in Tokyo, and at
  the wrong date for anchors near the end of the day.
- **Cost, accepted:** all-day and timed occurrences sort through different code
  paths, because comparing a `PlainDate` to an `Instant` requires choosing a
  timezone to compare in. The rendering timezone (`?tz=`) is that choice, and
  it is made at the edge rather than in storage.
- **Cost, accepted:** the derived range column must be recomputed if a
  calendar's timezone changes. It is a cache, so this is safe — but it must be
  documented as a cache, or someone will eventually read from it as truth.
- ICS serialisation is simplified: the timing union maps directly onto
  `DATE` vs. `DATE-TIME` value types, rather than being reconstructed from a
  boolean and a heuristic.
- Recurring all-day events expand over `PlainDate` arithmetic, which sidesteps
  DST entirely for that class of event. A weekly all-day series has no 23-hour
  or 25-hour day to reason about.

## Alternatives considered

**Zone-anchored (b).** Rejected on semantics, not on effort. Its whole
advantage was implementation convenience, and the derived-range approach above
recovers that advantage while keeping floating semantics. Once that was
apparent, (b) had nothing left to argue.

**Both, selected per calendar.** Rejected. It doubles the expansion, query, and
serialisation paths permanently in exchange for deferring a decision that has
a defensible answer. Configurability here is not flexibility; it is an
unresolved argument shipped to the user.

**Store all-day as timed events at 00:00 UTC.** A common shortcut, and wrong in
the same way as (b) but without (b)'s honesty about it — it hardcodes UTC as
the anchor for data that is not UTC-anchored, and it is invisible until someone
queries from a negative offset.
