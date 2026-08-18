# MVP Phase Breakdown

Operational expansion of [`../GAMEPLAN.md`](../GAMEPLAN.md). The gameplan argues
*what* we are building and *why*; these documents specify *what done looks like*
for each phase and *how it is proven*.

**Deliberately no durations or dates.** The gameplan carries some inherited
estimates; they are not repeated here. What follows is sequencing, specification,
and exit criteria. Relative size and risk are noted because they affect
*ordering*, not scheduling.

---

## Ordering rationale

Phases are ordered so the **least reversible** work happens first and the
**most demo-able** work happens late. This will feel wrong around Phase 2, when
there is still nothing to look at. That is the intended shape:

- **Recurrence correctness (Phase 1) is the only thing here that cannot be
  retrofitted.** Every stored event is shaped by the recurrence and all-day
  model. A UI built on a wrong model has to be rebuilt; a correct model with no
  UI is just an unfinished product.
- **Tenancy (Phase 2) is a security boundary.** Boundaries added after the fact
  leak, because by then code exists that predates them.
- **The embed surface (Phase 4) is the demo,** and it is also the most
  reversible layer — it sits behind an adapter precisely so it can be replaced.

## Status

| Phase | Scope | Size | Risk | Status |
|---|---|---|---|---|
| [0](00-foundation.md) | Foundation, license gate, CI | S | Low | ✅ done |
| [1](01-core-domain.md) | Core domain, recurrence, conformance corpus | L | **High** | ✅ done |
| [2](02-tenancy-auth.md) | Drizzle schema, RLS, JWT verification | M | **High** | ✅ done |
| [3](03-read-api.md) | Read API, ETag, OpenAPI | S | Low | ✅ done |
| [4](04-embed-surface.md) | Renderer adapter, Lit component, loader | L | Medium | ⬜ next |
| [5](05-ics-feed-out.md) | Tokened ICS feeds | S | Low | ⬜ |
| [6](06-write-path.md) | Write path, non-recurring only | M | Low | ⬜ |
| [7](07-ics-in-polish.md) | ICS ingest, a11y, docs, v0.1.0 | L | Medium | ⬜ |

Phases 1 and 4 are the two that historically overrun on projects of this shape.
Everything else is well-understood work.

---

## Decision gates

No phase may begin with an unresolved decision that it depends on. Open
decisions live in [`docs/decisions/README.md`](../../../decisions/README.md).

| Decision | Question | Must close before | Current state |
|---|---|---|---|
| O2 | JWT signing: HS256 vs. EdDSA + JWKS | Phase 2 work item 2.1 | ✅ Closed — EdDSA, registered public keys ([ADR-0009](../../../decisions/0009-eddsa-with-registered-public-keys.md)) |
| O4 | Materialise occurrences vs. expand on read | Phase 1 work item 1.3 | ✅ Closed — expand on read ([ADR-0007](../../../decisions/0007-expand-on-read.md)) |
| O5 | All-day semantics: floating vs. zone-anchored | **Phase 1 work item 1.1** — schema-affecting | ✅ Closed — floating dates ([ADR-0005](../../../decisions/0005-all-day-events-are-floating-dates.md)) |
| O6 | Governance model | Phase 7 | Open — no impact before then |
| **O7** | Server Temporal: native vs. polyfill | **Phase 1 work item 1.2** | ✅ Closed — polyfill behind one module ([ADR-0006](../../../decisions/0006-temporal-acquisition.md)). Discovered, not planned — see below |

### O7 was discovered, not planned

L6 asserts "native in … Node 26+, so the server runs native Temporal and only
the client pays for a polyfill." Verified against the toolchain actually
installed:

```
$ node --version
v26.3.0
$ node -e "console.log(typeof globalThis.Temporal)"
undefined
$ node --harmony-temporal -e "console.log(typeof Temporal)"
undefined          # the V8 flag exists and defaults on, but Node exposes nothing
```

The premise does not hold on this runtime. Resolved in
[ADR-0006](../../../decisions/0006-temporal-acquisition.md): `@gnomon/core`
depends on `temporal-polyfill` on both server and client, behind a single
`src/temporal.ts` re-export, so switching to native later is a one-file
change. `packages/core/test/purity.test.ts` enforces the chokepoint.

The good news, also verified: `rrule-temporal` operates on whatever
`ZonedDateTime` objects it is handed and does **not** require a global
`Temporal`, so either resolution works. Its DST behaviour is correct — a weekly
09:00 `America/New_York` series holds 09:00 local across the 2026-03-08
spring-forward while the UTC offset moves `-05:00 → -04:00`.

---

## How to read a phase document

Each phase document has the same sections:

- **Objective** — one paragraph, the thing that is true afterwards that wasn't before
- **Decisions in play** — locked constraints that shape the work, open ones it must close
- **Work items** — numbered, with concrete paths and interfaces
- **Exit criteria** — testable assertions, not activities. "An RLS test proves
  tenant A cannot read tenant B's events" is an exit criterion; "implement RLS"
  is not.
- **Verification** — the commands that demonstrate the exit criteria
- **Risks** — what specifically goes wrong here, and the mitigation
- **Out of scope** — the adjacent work this phase deliberately does not do

Work item numbering (`1.3`, `2.4`) is stable and quotable in commits, issues,
and ADRs.
