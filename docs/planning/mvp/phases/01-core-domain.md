# Phase 1 — Core domain ⚠️ highest risk

**Status:** ✅ Complete
**Depends on:** Phase 0
**Blocks:** Phases 2–7 (every stored event is shaped by decisions made here)
**Decisions in play:** L4 (read-mostly), L6 (Temporal), L9 (I/O-free core)
**Must close:** **O5** (all-day semantics), **O4** (expansion strategy), **O7** (Temporal acquisition)

---

## Objective

`@gnomon/core` expands real-world recurrence rules correctly across timezone
and DST boundaries, and round-trips ICS, with a fixture corpus that makes the
correctness claim checkable rather than asserted — all before any UI, API, or
schema exists to be shaped by a wrong model.

**Why this ordering is non-negotiable.** Recurrence and all-day semantics are
the only decisions in this project that are expensive to reverse. A renderer
can be swapped behind the adapter. An API can be versioned. Stored events
written under the wrong all-day model require a data migration that has no
correct answer — the information needed to migrate them was never captured.

---

## Decisions to close

### 1.1 O5 — all-day semantics *(schema-affecting; close first)*

Currently flagged inline in `packages/core/src/types.ts`. Two candidate models:

**(a) Floating date.** An all-day event is a `PlainDate` with no zone.
"October 3rd" is October 3rd everywhere. Matches RFC 5545 `DATE`-valued
`DTSTART` and matches user intuition for holidays, birthdays, and
"bin collection day."

**(b) Zone-anchored.** An all-day event is a `ZonedDateTime` range anchored to
the calendar's timezone. Easier to index in a single `tstzrange` GiST column,
easier to sort against timed events in one view.

**Recommendation: (a) floating, with a derived span for indexing.**

The argument for (b) is entirely an implementation convenience, and it is
purchasable without adopting (b)'s semantics. Store all-day events as `DATE`
and derive a `tstzrange` — resolved against the calendar timezone — as a
*coarse pre-filter index only*, with exact boundaries applied after the index
scan. That buys (b)'s query plan while keeping (a)'s meaning.

The argument for (a) is semantic and irreversible: under (b), a tenant that
corrects its timezone silently moves every historical all-day event, and a
viewer in Tokyo sees a US holiday land on the wrong day. Under (a), the only
cost is that all-day and timed events sort through slightly different code.

This resolution needs an ADR before any Drizzle migration lands.

### 1.2 Temporal acquisition (O7)

L6 assumes native `Temporal` on the server. Verified false on Node 26.3.0 — see
[the phases README](README.md#o7-was-discovered-not-planned). Options:

1. **Depend on `temporal-polyfill` unconditionally in `@gnomon/core`.**
   Simplest, one code path, identical behaviour server and client. Costs bundle
   weight in the browser even once Safari ships.
2. **Inject a `Temporal` implementation at the package boundary.** Keeps
   `@gnomon/core` implementation-agnostic and lets each host feature-detect.
   Costs an awkward initialisation step in every consumer, including tests.
3. **Feature-detect inside core** with a lazy dynamic import.

**Recommendation: (1) for now, structured so (3) is a later change and not a
rewrite** — confine all Temporal imports to a single `packages/core/src/temporal.ts`
re-export module, and forbid direct `temporal-polyfill` imports elsewhere.
Nothing else in core should know where `Temporal` came from.

`temporal-polyfill` is MIT and its transitive `temporal-spec` is Apache-2.0 —
both already pass the licence gate.

### 1.3 O4 — materialise vs. expand on read

Ledger default stands: **expand on read**, bounded by `MAX_WINDOW_DAYS` (400),
already enforced in `packages/core/src/window.ts`. Materialisation is a cache
decision and should wait until there is a slow query to point at. Record the
decision, do not build for it.

---

## Work items

### 1.4 Finalise domain types

Resolve the `TODO(O5)` in `packages/core/src/types.ts` into a real
discriminated union rather than a boolean flag. `allDay: boolean` alongside
string `start`/`end` cannot express the distinction the model requires — it
lets an all-day event carry a meaningless time component, and pushes the
interpretation onto every consumer.

Roughly:

```ts
type EventTiming =
  | { kind: 'timed';  start: string; end: string; timeZone: TimeZoneId }  // ZonedDateTime
  | { kind: 'allDay'; startDate: string; endDate: string }                // PlainDate, exclusive end
```

Exclusive `endDate` matches RFC 5545 `DTEND` for `DATE` values and removes the
off-by-one that otherwise appears in every single-day all-day event.

Also missing from the current types and needed before Phase 2: `EventStatus`
(confirmed / tentative / cancelled), a `sequence` for override matching, and a
`uid` distinct from `id` — the ICS `UID` must survive a round trip and must not
be assumed equal to our primary key.

### 1.5 Recurrence expansion service

`packages/core/src/expand.ts`, over `rrule-temporal` (MIT, v2.1.0).

- Signature takes an event plus a `QueryWindow`; **every** path routes through
  `assertWindow` — there must be no way to expand unbounded.
- Applies `EXDATE` removal and `RECURRENCE-ID` override substitution.
- Returns occurrences ordered by start.
- Caps occurrence count independently of window days: a 400-day window against
  `FREQ=MINUTELY` is inside the day cap and still ~576,000 occurrences. The
  day cap alone is not a sufficient DoS control — this is a gap in the current
  `window.ts` guard.

**Verified working:** `rrule-temporal` accepts injected `ZonedDateTime` objects
and needs no global `Temporal`; a weekly 09:00 `America/New_York` series holds
09:00 local across the 2026-03-08 spring-forward while the offset moves
`-05:00 → -04:00`.

### 1.6 Recurrence conformance corpus

**The single highest-value test asset in the project.** Golden-file fixtures,
each a small ICS input plus expected expansion over a stated window. Required
coverage:

| Case | Why it breaks implementations |
|---|---|
| DST spring-forward, wall-clock preserved | Naive UTC-offset arithmetic shifts the event an hour |
| DST fall-back, ambiguous local time | Two valid instants; disambiguation policy must be explicit |
| Event scheduled *into* the spring-forward gap (02:30 on a US transition) | The local time does not exist; the policy must be stated and tested |
| `BYDAY` with ordinals (`-1SU`, `2MO`) | Month-length and week-numbering edge cases |
| `BYSETPOS` | Frequently unimplemented or wrong |
| `UNTIL` vs `COUNT` | `UNTIL` is UTC-valued even for zoned `DTSTART` |
| `UNTIL` exactly equal to an occurrence | Inclusive per RFC 5545; commonly off by one |
| `EXDATE` | Must match by instant, not by string form |
| `RECURRENCE-ID` overrides, including moved instances | Override may fall outside the window while its rule instance is inside |
| Leap years, 29 Feb yearly rules | Non-leap-year behaviour is genuinely ambiguous; pick and document |
| 31st-of-month monthly rules | Months without a 31st are skipped, not clamped |
| Cross-timezone `DTSTART` vs. query timezone | The case `Date`-based libraries cannot express |
| Zero-duration and multi-day occurrences | Boundary arithmetic at window edges |
| Window-boundary straddling | Occurrence starting before `from` but ending after it must be included |

Fixtures live in `packages/core/test/fixtures/` as data, not as inline
literals, so they can be regenerated and diffed. Where behaviour is genuinely
underspecified by RFC 5545, the fixture records **our** decision and cites it.

### 1.7 ICS parse (in)

Via `node-ical` (Apache-2.0). Handles `RRULE` expansion, `EXDATE`,
`RECURRENCE-ID`, and Windows→IANA timezone mapping.

**Resolved — it cannot.** `node-ical` 0.27.1's entry imports `node:fs`, its
parser imports `node:crypto`, and its `exports` map offers no way to reach the
parser without the `fs` import. ICS interop therefore lives behind a
`@gnomon/core/ics` subpath, documented Node-only; the main entry stays pure.
See [ADR-0008](../../../decisions/0008-ics-parsing-is-a-node-only-subpath.md).

Its dependency footprint is otherwise excellent — only `rrule-temporal` and
`temporal-polyfill`, both already ours. It is used **strictly as a text
parser**: it shares our `rrule-temporal` and would expand recurrences itself,
inheriting all three defects `expand.ts` corrects.

### 1.8 ICS serialise (out)

Hand-rolled against RFC 5545 — the output surface is narrow and fully ours.
The parts that are actually hard and must be tested:

- **Line folding at 75 octets**, folding on octet boundaries not character
  boundaries — multi-byte UTF-8 split across a fold is the classic bug
- Escaping of `,`, `;`, `\`, and newlines in `TEXT` values
- CRLF line endings, unconditionally
- `DATE` vs. `DATE-TIME` value types, driven by the Phase 1.1 timing union
- `VTIMEZONE` emission for zoned events

### 1.9 Round-trip property test

Parse → serialise → parse must reach a fixed point. Property-based over the
fixture corpus rather than a handful of examples.

---

## Upstream defects found, and corrected here

The corpus earned its keep before any UI existed. Three defects in
`rrule-temporal` 2.2.0, each corrected in `expand.ts` and pinned by a fixture
carrying a `regression` note. All three were verified load-bearing by disabling
the correction and watching the specific fixture go red.

| Defect | Observed | Correct | Correction |
|---|---|---|---|
| DST gap shift is sticky | Daily 02:30 `America/New_York` returns 03:30 on 2026-03-08 **and every day after**, though 02:30 exists again on 03-09 | Only the gap day moves | `reanchorWallClock` — re-anchor each occurrence to DTSTART's wall-clock time, letting Temporal's `compatible` disambiguation shift only where required |
| Implied `BYMONTHDAY` clamps, and the clamp sticks | `FREQ=MONTHLY` from 2026-01-31 returns Jan 31, **Feb 28, Mar 28, Apr 28** — wrong even for March, which has a 31st | Jan 31, Mar 31, May 31, Jul 31 | `normalizeRule` — make RFC 5545's own default explicit (`BYMONTHDAY` from DTSTART), routing onto the library's correct path |
| Implied yearly date clamps | `FREQ=YEARLY` from 2024-02-29 returns 2025-02-28 | 2028-02-29 | Same, injecting `BYMONTH` + `BYMONTHDAY` |
| RRULE parts are reordered on parse | `FREQ=WEEKLY;BYDAY=MO;COUNT=3` comes back as `FREQ=WEEKLY;COUNT=3;BYDAY=MO` | Byte-stable output for one rule | `canonicalRRule` — emit a fixed part order. Harmless semantically; a feed whose bytes change on every regeneration defeats the ETag work in phases 3.3 and 5.3 |

The first three share a cause: an iteration cursor mutated when a date is
invalid, carrying the error forward. The fourth is a formatting choice rather
than a correctness bug, and matters only because ICS output has to be stable.

Worth knowing before a dependency bump: if a `regression` fixture starts
failing, the library was fixed upstream and our correction may now
double-apply.

## Exit criteria

- [x] O5 resolved and recorded as an ADR; `types.ts` carries no `TODO(O5)`
- [x] O7 resolved and recorded; all Temporal access flows through one module
- [x] O4 recorded as accepted-default
- [x] Every case in the 1.6 table has a fixture, including the ones where our
      answer is a choice rather than a rule
- [x] No expansion path can be reached without passing `assertWindow`, and an
      occurrence-count cap exists independent of the day cap
- [x] `@gnomon/core` expands a nasty real-world ICS file correctly across a DST
      boundary, with fixtures proving it
- [x] Round-trip reaches a fixed point across the whole corpus — and, more
      strongly, preserves *expanded occurrences* per fixture, so a systematic
      misreading cannot survive by being byte-stable
- [x] `@gnomon/core`'s main entry has no I/O; the exception is
      [ADR-0008](../../../decisions/0008-ics-parsing-is-a-node-only-subpath.md),
      and `test/purity.test.ts` enforces it rather than trusting review

**93 tests.**

---

## Verification

```bash
pnpm --filter @gnomon/core test
pnpm --filter @gnomon/core typecheck
```

The DST claim should be independently checkable from a one-liner, not only
from the suite — a maintainer must be able to confirm it without reading test
code.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `rrule-temporal` is wrong somewhere subtle | **High** | The corpus tests *our expansion behaviour*, not the library's. If it's wrong, fixtures catch it and the fix is local. Version is pinned. |
| Corpus is written to match the implementation rather than the spec | **High** | Derive expected values from RFC 5545 and from cross-checking a second implementation — never from our own output. This is the failure mode that makes a conformance suite worthless. |
| O5 answered implicitly by writing code before the ADR | **High** | 1.1 is ordered first for this reason. |
| `node-ical` drags I/O into core | Medium | Confirm before depending on it (1.7). |
| Occurrence-count DoS via high-frequency rules inside a legal window | Medium | Explicit cap in 1.5. |

---

## Out of scope

- Persistence of any kind — no Drizzle, no SQL (Phase 2)
- Recurrence *editing* semantics (L4 — deferred past v0.1)
- Materialised occurrence tables (O4 — deferred until a slow query exists)
- Timezone *database* currency concerns — we defer to the platform's IANA data
- `VALARM`, `VTODO`, `VJOURNAL`, attachments, rich text
