# ADR-0007: Occurrences are expanded on read, never materialised

**Status:** Accepted
**Date:** 2026-08-10
**Relates to:** O4 (closed), L4, Phase 1

## Context

A recurring event can be stored once with an `RRULE` and expanded when queried,
or expanded once and written out as rows in an occurrences table.

Materialisation makes reads a plain indexed range scan. It also introduces a
derived dataset that must be invalidated whenever the rule, the calendar
timezone, the IANA timezone database, or the expansion horizon changes — and a
question with no good answer: how far ahead do you materialise an unbounded
rule?

## Decision

**Expand on read, bounded by `MAX_WINDOW_DAYS` (400), enforced in the domain
layer at `packages/core/src/window.ts`.**

No materialised occurrence table in v0.1. Materialisation is a caching
decision, and it is deferred until there is a specific slow query to point at.

Two guards, not one:

1. **A window cap** — the requested range may not exceed `MAX_WINDOW_DAYS`.
2. **An occurrence-count cap** — independent of the window. A 400-day window
   against `FREQ=MINUTELY` is legal under the day cap and still expands to
   roughly 576,000 occurrences. The day cap alone is not a DoS control, and
   the original `window.ts` guard had only the day cap.

Both live in the domain layer rather than at the HTTP edge, because embeds are
public-facing by design and tokens are handed out liberally by host portals.
There must be no code path that expands a rule without passing through them —
including the ICS feed path (Phase 5) and any future job.

## Consequences

- No invalidation problem, because there is no derived data to invalidate. When
  a tenant fixes a calendar's timezone, or the IANA database updates, the next
  read is simply correct.
- Reads cost CPU rather than storage. For the expected shape — a portal
  rendering a month or an agenda — this is a small bounded expansion per
  request, and ETag-conditional responses (Phase 3) mean most repeat reads cost
  nothing at all.
- The 400-day cap is visible to integrators. A "show me the next five years"
  feature is not expressible in one request; that is a deliberate limit and
  belongs in the documented-limitations page (Phase 7.3).
- If this proves wrong, the fix is additive: a materialised table becomes a
  cache in front of the same expansion function, and `@gnomon/core` does not
  change. Choosing materialisation now would be the harder decision to reverse,
  which is the asymmetry that settles it.
- The occurrence cap needs a distinguishable error, so a client can tell "your
  window is too wide" from "your rule is too dense" — the remedies differ.

## Alternatives considered

**Materialise on write.** Fastest reads. Requires answering "how far ahead?"
for rules with no `UNTIL` or `COUNT`, and every answer is arbitrary. Rejected
as premature: we have no query to make faster.

**Materialise lazily, as a cache keyed by (event, window).** The likely
eventual answer if reads become slow. Explicitly deferred rather than rejected —
this ADR is what it will supersede.
