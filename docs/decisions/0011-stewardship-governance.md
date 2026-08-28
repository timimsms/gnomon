# ADR-0011: Stewardship governance, revisited at scale

**Status:** Accepted
**Date:** 2026-08-28
**Relates to:** O6 (closed), ADR-0001
**Blocks:** the v0.1.0 tag

## Context

O6 asked which governance model Gnomon should declare. It was deferred to
Phase 7 on the grounds that it "only matters when outside contributors
arrive" — and the thing that invites them is precisely the v0.1.0 tag this
phase produces. Deciding it after the first contentious pull request means
deciding it under pressure, with a specific person and a specific
disagreement in the room.

Gnomon is MIT and courts adoption (ADR-0001), so the question is not academic:
someone evaluating whether to contribute wants to know who decides, and
whether their work can be overruled without explanation.

Three options were considered, and the honest starting point is that this is
a one-maintainer project with no outside contributors yet.

## Decision

**Stewardship: one maintainer with final say on scope, technical decisions
gated by ADR, and an explicit trigger to revisit.**

Recorded in [`GOVERNANCE.md`](../../GOVERNANCE.md).

The load-bearing part is the second clause. **The ADR requirement binds the
maintainer too**, and that is not aspirational — it has already constrained
every phase of this project. Decisions were written before the code, and when
one proved wrong it was overturned by a superseding ADR rather than by a quiet
diff:

- L6 asserted native `Temporal` on Node 26. It is not available, and
  [ADR-0006](0006-temporal-acquisition.md) amended the locked decision rather
  than the code silently diverging from it.
- Phase 2.6 specified testcontainers, which requires the very dependency it
  was chosen to avoid needing.
  [ADR-0010](0010-test-database-provisioning.md) replaced it.

A project where the maintainer can be shown to be wrong in writing, and
changes course in writing, is already exercising the substance of governance.
The document says so rather than inventing roles on top of it.

The revisit trigger is **roughly three regular contributors**, plus two
qualitative ones that can fire sooner: the maintainer becoming a review
bottleneck, and nobody else being able to ship a release. A project that
cannot issue a security fix while one person is away has a governance problem
rather than a scheduling one.

## Consequences

- **Bus factor one, stated openly.** Anyone evaluating Gnomon can see it
  rather than discovering it. That is the cost of being honest, and it is
  lower than the cost of implying a bench that does not exist.
- No advancement path to point at. A contributor asking "can I earn commit
  rights here?" gets "not yet defined, and here is the trigger that defines
  it" instead of a rung to climb. Acceptable while the population is zero.
- The ADR requirement is a real constraint on the maintainer and will
  occasionally be inconvenient. That is the point; a governance rule only
  binding other people is not one.
- This document has a shelf life by construction. It names the conditions
  under which it becomes false, so it should fail loudly rather than quietly
  ageing into fiction.
- Security reports route privately to the maintainer. With no security team,
  saying otherwise would be theatre.

## Alternatives considered

**A contributor ladder now.** Documented rungs from contributor to committer
to maintainer, with criteria and an escalation path. Rejected as scaffolding
for a population that does not exist: it invites comparison with projects that
genuinely run that way, and the first honest question — "who is on the second
rung?" — has no answer. Worth revisiting at the trigger above, which is
exactly when the answer stops being embarrassing.

**Defer past v0.1.0.** Least effort, and it leaves the one open decision in
the ledger open through the release it was meant to close before. A drive-by
contributor would have no idea who decides or how, and the model would end up
written after the first disagreement — which is the worst moment to write one.

**Adopt an off-the-shelf model** (a foundation's template, or a
Contributor Covenant-style structure). Rejected for the same reason as the
ladder at this size: these are good documents describing organisations Gnomon
is not, and adopting one would describe the project inaccurately in a
direction that flatters it.
