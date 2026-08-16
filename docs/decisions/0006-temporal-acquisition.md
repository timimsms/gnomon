# ADR-0006: Temporal comes from the polyfill, behind one module

**Status:** Accepted
**Date:** 2026-08-10
**Relates to:** O7 (closed), L6, L9, Phase 1
**Amends:** L6

## Context

L6 states that Temporal is "Stage 4 / ES2026 as of March 2026; native in
Chrome 144+, Firefox 139+, Edge 144+, **Node 26+**. Safari is the sole holdout,
so polyfill on the client. **Server runs native.**"

The server half is false on the runtime we actually have:

```
$ node --version
v26.3.0

$ node -e "console.log(typeof globalThis.Temporal)"
undefined

$ node --harmony-temporal -e "console.log(typeof Temporal)"
undefined

$ node --v8-options | grep -A1 harmony-temporal
  --harmony-temporal (enable "Temporal")
        type: bool  default: --harmony-temporal
```

V8 reports the flag as defaulting to *on*, and `Temporal` is still not exposed.
Whatever the cause, the practical result is that a Node 26 server cannot rely
on native Temporal, and the "polyfill is a client-only cost" framing does not
hold.

Two facts made this cheap to resolve rather than expensive:

- `rrule-temporal` (the Phase 1 recurrence engine) operates on whatever
  `ZonedDateTime` objects it is handed and does **not** require a global
  `Temporal`. Verified: a weekly 09:00 `America/New_York` series holds 09:00
  local across the 2026-03-08 spring-forward while the offset moves
  `-05:00 → -04:00`.
- `temporal-polyfill` is MIT, and its only dependency `temporal-spec` is
  Apache-2.0. Both pass the licence gate (ADR-0002) unmodified.

## Decision

**`@gnomon/core` depends on `temporal-polyfill` unconditionally, and every
Temporal access in the codebase flows through a single re-export module:**

```ts
// packages/core/src/temporal.ts
export { Temporal } from 'temporal-polyfill';
```

No other module imports `temporal-polyfill` directly. Nothing in core knows
where `Temporal` came from.

L6 is amended: **both** server and client use the polyfill for now, rather than
server-native and client-polyfilled.

## Consequences

- One code path, identical behaviour on server and client. Given that the
  entire point of L9 (`packages/core` is I/O-free) is that expansion runs
  identically in both places, having *different Temporal implementations* in
  those two places would have undercut it. This is arguably better than the
  original plan, not merely a fallback from it.
- Browser bundles carry the polyfill even on engines that ship Temporal
  natively. This is a real cost, and it is bounded and temporary.
- **The chokepoint module is the whole point.** Switching to native, or to
  feature-detected lazy loading, becomes a one-file change rather than a sweep
  through every module that touches a date. Enforce it — a direct
  `temporal-polyfill` import outside `temporal.ts` should fail lint once
  linting exists (deferred in Phase 0), and should fail review until then.
- Fixtures and expansion results are reproducible across environments, because
  there is only one implementation producing them. A conformance corpus
  validated against a different Temporal implementation than the one running in
  production would be quietly worthless.
- Revisit when Node exposes `Temporal` **and** Safari ships it. Until both are
  true, feature detection pays a complexity cost for a benefit no user has.

## Alternatives considered

**Inject a Temporal implementation at the package boundary.** Keeps core
implementation-agnostic, which is architecturally cleaner. Rejected because it
requires an initialisation step in every consumer — including every test file
and every fixture — for a package whose value proposition is that an integrator
can import it and expand recurrences client-side without ceremony.

**Feature-detect with a lazy dynamic import.** The right long-term answer, and
today it is all cost and no benefit: no runtime we target actually has native
Temporal, so the detection branch never fires, while the async boundary it
introduces complicates core's initialisation permanently. The chokepoint module
means adopting this later is cheap, so there is no reason to adopt it early.

**Pin to an older Node and wait.** Not a decision, just a delay, and it would
have left the false premise in L6 undiscovered until Phase 2.
