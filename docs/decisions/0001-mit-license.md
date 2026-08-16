# ADR-0001: Gnomon is MIT licensed

**Status:** Accepted
**Date:** 2026-08-09
**Relates to:** L1

## Context

Gnomon's premise is that a platform company can offer a calendar to its end
users for free. That premise has two failure modes, and only one of them is
technical.

The technical one is operating cost, addressed by L8 (single container plus
Postgres, no broker).

The other is legal review. An integrator evaluating an embeddable component
asks their counsel one question: *can we ship this in our product without
opening our source?* If the answer requires a conversation, most evaluations
stop there — not because the answer is no, but because the conversation costs
more than the component is worth to them. A free add-on that requires a legal
review is not free.

The copyleft options were considered seriously, because the concern behind them
is real. AGPL would prevent a well-funded competitor from taking Gnomon,
hosting it, and selling it back. That is a genuine risk and MIT does nothing
about it.

## Decision

**MIT.**

The licence is chosen for the integrator, not for us. Adoption by portal
vendors is the entire point of the project; a licence that deters the exact
people we are courting defeats it regardless of what it protects.

This extends to dependencies: see ADR-0002. An MIT project with an AGPL
dependency is an AGPL project that has not noticed yet.

## Consequences

- **We cannot prevent SaaS repackaging.** Someone may host Gnomon commercially
  and contribute nothing. Accepted explicitly, not overlooked.
- The defence against that outcome is being the best-maintained implementation
  with the clearest upgrade path — not a licence clause. This is a weaker
  defence and it is the one consistent with the goal.
- Every dependency must be permissive, enforced in CI rather than by intent
  (ADR-0002).
- Relicensing later is effectively impossible once outside contributors exist,
  since it would require their agreement. The decision is therefore more
  permanent than most in this ledger, which is why it is ADR-0001.
- We do not require a CLA. A CLA would preserve the option to relicense, and
  it is itself a contribution barrier — the same trade as the licence, decided
  the same way.

## Alternatives considered

**AGPL-3.0.** Protects against uncompensated commercial hosting. Rejected
because it makes embedding into a proprietary portal a question for counsel,
and the answer — that embedding via a network API does not trigger copyleft —
is one an integrator has to pay a lawyer to hear. The uncertainty is the cost,
not the outcome.

**Apache-2.0.** Nearly equivalent in permissiveness, with an express patent
grant that is a genuine improvement, and a NOTICE requirement that is a minor
distribution burden. Rejected narrowly: MIT is shorter, more universally
recognised, and passes review faster. For a component whose adoption story
depends on *not needing review*, familiarity has real value.

**BSL or a source-available licence with a time delay.** Rejected. These
protect a commercial model that Gnomon does not have, at the cost of not being
open source, which is the only distribution advantage the project has.
