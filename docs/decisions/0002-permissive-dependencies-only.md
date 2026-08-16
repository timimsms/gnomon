# ADR-0002: Permissive dependencies only, enforced in CI

**Status:** Accepted
**Date:** 2026-08-09
**Relates to:** L2, ADR-0001, ADR-0003

## Context

ADR-0001 commits Gnomon to MIT so integrators can embed it without legal
review. That commitment is only as strong as the dependency tree beneath it: a
single copyleft dependency relicenses the distributed work, and the project
becomes something other than what its LICENSE file claims.

The realistic path to that outcome is not carelessness. It is a well-meaning
contributor adding a feature:

- **FullCalendar v7** (June 2026) moved Premium packages from GPLv3 to AGPLv3.
  A contributor adding a resource or timeline view reaches for
  `@fullcalendar/resource-timeline` because it is the obvious package for the
  job, and it is AGPL.
- **Schedule-X v4** (January 2026) moved drag-and-drop and resize out of the
  MIT core into `@sx-premium/*`.

In both cases the contributor is solving a real problem with the documented
package. Nothing about the experience signals a licensing event. By the time
anyone notices, the dependency is load-bearing.

Review does not catch this reliably. A reviewer sees a plausible package name
in a diff and a feature that works. Transitive dependencies are worse: nobody
reads the third level of a lockfile.

## Decision

**Every dependency, direct and transitive, must carry a permissive SPDX
licence from an explicit allowlist. Enforced by `scripts/check-licenses.mjs`,
which runs in CI before typecheck and before tests.**

Licences run first deliberately. A copyleft dependency is a licensing
incident, not a test failure; it should fail fast and be unmistakable in the
log rather than buried under a test run.

The gate **fails closed**. An unrecognised licence — including `UNLICENSED`,
`SEE LICENSE IN ...`, and a missing licence field — is a violation, not an
unknown to be waved through. A licence nobody has classified is exactly the
case where a human should look.

Adding to the allowlist requires an ADR. This is intended friction: the fix for
a red gate must never be a one-line diff to the allowlist, because that diff is
indistinguishable from a legitimate one in review.

The gate itself is unit-tested (`scripts/check-licenses.test.mjs`) against
fixture reports including AGPL, GPL, LGPL, and unknown-licence inputs. A gate
that has never been observed to reject anything is not a gate — if the report
format changed and parsing silently yielded nothing, an untested gate would
report success forever. It also exits **2** rather than 1 when it cannot read
the report, so a tooling failure is never mistaken for a pass.

Currently allowed: MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD,
CC0-1.0, Unlicense, BlueOak-1.0.0, Python-2.0, MIT-0, plus an enumerated set of
dual-licence expressions.

## Consequences

- Some genuinely good libraries are unavailable. When that happens the answer
  is usually to implement the narrow slice we need, or to drop the feature —
  not to widen the allowlist.
- The exemptions map exists and should stay empty. A non-empty exemptions list
  is a standing risk with a comment attached.
- This gate is a backstop, not the primary defence. ADR-0003 puts the renderer
  behind an adapter so that no Gnomon code imports a renderer package directly
  — an architecture that does not rely on a CI check to stay legal is better
  than one that does. The gate catches what the architecture misses.
- Dual-licence expressions are matched literally rather than parsed. A real
  SPDX expression parser is more surface area than this gate deserves, and the
  failure mode of literal matching is a false rejection, which is safe.
- CI installs with `--frozen-lockfile`, so the gate inspects what will actually
  be installed rather than a fresh resolution.

## Alternatives considered

**Manual review.** Free, and fails exactly where the risk is: plausible package
names and transitive dependencies.

**A commercial licence-scanning service.** More thorough, particularly on
licence *texts* that disagree with their declared SPDX identifier. Rejected as
disproportionate, and it introduces a paid dependency into the build of a
project whose thesis is near-zero marginal cost.

**Allow copyleft for devDependencies.** Defensible — build tools are not
distributed — and rejected. It requires every contributor and reviewer to
correctly classify a dependency as dev-only and to keep it that way, which is
precisely the judgement call this ADR exists to remove.
