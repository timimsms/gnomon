# Governance

Gnomon has one maintainer. This document says so plainly, because the
alternative — implying a structure that does not exist — wastes the time of
anyone deciding whether to invest in the project.

## Who decides

**Tim Walsh** maintains Gnomon and has final say on scope: what the project
is for, what it declines to become, and when a release is ready.

Scope decisions are judgement calls and are not gated by process. The
[non-goals](docs/planning/mvp/GAMEPLAN.md#5-explicit-non-goals-for-v01) are
the clearest statement of them; "no" to a feature usually means it belongs in
a different project, not that it is a bad idea.

## How technical decisions are made

**Architecture decisions are gated by ADR, and that constraint binds the
maintainer too.**

This is not aspirational. Every phase of this project has been bound by it:
decisions were written down before the code, and where a decision turned out
to be wrong — Temporal's availability on Node, testcontainers requiring the
one dependency it was meant to avoid — it was overturned by a superseding ADR
rather than by a quiet diff.

In practice:

- A decision that shapes the schema, the security boundary, the dependency
  set, or a public interface gets an ADR before the code.
- An ADR records what was **rejected** and why, not only what was chosen.
  That is the part which is expensive to reconstruct later.
- A locked decision can be overturned. It takes a superseding ADR, not a pull
  request that quietly contradicts it.
- If a PR contradicts a locked decision, say so in the description. Expect the
  ADR conversation first, and expect it to be a real conversation — several
  locked decisions here have already been overturned on evidence.

The ledger lives in [`docs/decisions/README.md`](docs/decisions/README.md).

## Contributing

Pull requests are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup,
the CI gates, and the testing discipline the project actually uses.

There is no committer ladder, because there is no queue of people on it.
Writing one now would be scaffolding for a population that does not exist.

## When this changes

**At roughly three regular contributors**, this document stops describing
reality and should be replaced with something that does — most likely a
defined path to commit rights and a written rule for resolving disagreement
without the maintainer present.

Two other triggers, either of which should force a rewrite sooner:

- **The maintainer becomes a bottleneck.** If PRs sit unreviewed for want of
  one person's attention, the structure is wrong regardless of contributor
  count.
- **Somebody needs to be able to release without the maintainer.** A project
  that cannot ship a security fix while one person is on holiday has a
  governance problem, not a scheduling problem.

## Security

Report suspected vulnerabilities privately to the maintainer rather than in a
public issue. Gnomon's security boundaries — tenant isolation, token
verification, feed tokens, SSRF protection on tenant-supplied URLs — each have
tests written to fail if the control is removed. A report that comes with a
failing test is the fastest possible route to a fix.
