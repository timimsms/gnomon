# Phase 0 — Foundation

**Status:** 🟡 Mostly done. Four gaps, listed below.
**Depends on:** nothing
**Blocks:** everything
**Decisions in play:** L1 (MIT), L2 (permissive deps), L8 (Postgres only), L9 (TS + pnpm)

---

## Objective

A clean clone installs and goes green without local knowledge, and the licence
guarantee that makes the project embeddable is enforced by machine rather than
by intent.

---

## Work items

### 0.1 Repo scaffold — ✅ done

pnpm workspaces (`packages/*`, `apps/*`), `tsconfig.base.json` with strict
settings including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
and `verbatimModuleSyntax`. Workspace members exist for `core`, `embed`,
`loader`, `server`, `demo-portal`; the last four are stubs.

### 0.2 Licence, contributing, ADR directory — ✅ done

`LICENSE` (MIT), `CONTRIBUTING.md`, `docs/decisions/` with a ledger README.

### 0.3 Licence-compliance CI gate — ✅ done

`scripts/check-licenses.mjs` reads `pnpm licenses list --json --long`, checks
each package against a permissive SPDX allowlist, exits non-zero on violation.
Currently passes across 45 packages.

The gate is intentionally hostile to the easy fix: the allowlist is documented
as ADR-gated, so widening it is a decision rather than a diff.

### 0.4 Docker compose with Postgres — ✅ done

`docker-compose.yml` pins `postgres:17-alpine` on host port **5433** (avoiding a
collision with a local 5432), with a `pg_isready` healthcheck.

> Note: Docker is not installed on the current development machine. This is
> not a repo defect, but Phase 2 onward cannot be verified locally until it is.
> Flagged here so it surfaces before Phase 2 rather than during it.

### 0.5 CI workflow — ❌ **gap**

The gameplan lists CI as a Phase 0 deliverable and `CONTRIBUTING.md` documents
three ordered gates, but no `.github/workflows/` exists. The documented
contract is currently unenforced.

Required: a workflow running, in this order, on push and PR —

1. `pnpm lint:licenses`
2. `pnpm typecheck`
3. `pnpm test`

Licences first is deliberate and is stated in `CONTRIBUTING.md`: a copyleft
dependency is a licensing incident, not a test failure, and should fail before
anything slower runs.

### 0.6 `.gitignore` — ❌ **gap**

There is none. `node_modules/` shows as untracked, and `.DS_Store` files are
already committed at four paths. Every contributor's first `git status` is
noisy, and the first careless `git add -A` commits a dependency tree.

### 0.7 ADR-0001 and ADR-0002 — ❌ **gap**

`README.md` and `CONTRIBUTING.md` both cite ADR-0002 as the authority for the
licence gate. `docs/decisions/` contains only 0003 and 0004. The two ADRs that
justify the project's foundational constraints — MIT licensing, and
permissive-only dependencies — are referenced but absent.

### 0.8 Node engine range — ❌ **gap**

Root `package.json` declares `"node": ">=22"`; `apps/server` declares `>=26`.
The 26 requirement existed only to obtain native `Temporal`, which
[O7](README.md#o7-was-discovered-not-planned) establishes is not actually
available on Node 26.3.0. The constraint should be restated once O7 resolves,
rather than left as an unexplained inconsistency.

---

## Exit criteria

- [x] `pnpm install && pnpm test` green on a clean clone
- [x] `pnpm lint:licenses` passes and fails loudly on a copyleft dependency
- [ ] CI enforces all three gates, in the documented order, on every PR
- [ ] `git status` is clean immediately after `pnpm install`
- [ ] Every ADR referenced by `README.md` or `CONTRIBUTING.md` exists
- [ ] The Node engine range is consistent across the workspace and justified

---

## Verification

```bash
pnpm install
pnpm lint:licenses && pnpm typecheck && pnpm test
git status --porcelain      # must be empty
```

For the licence gate specifically — it must be proven to fail, not merely
observed to pass:

```bash
pnpm add -D -w some-agpl-package && pnpm lint:licenses   # must exit 1
```

---

## Risks

| Risk | Mitigation |
|---|---|
| Licence gate passes vacuously (misparsed report, no packages inspected) | It prints the package count. Assert on a known-bad package before trusting it. |
| `pnpm licenses list` output shape changes between pnpm majors | The gate exits 2 (distinct from 1) when it cannot read the report, so a parse failure is not mistaken for a pass. |
| Docker absent locally | Surfaced now; blocks Phase 2 verification, not Phase 1. |

---

## Out of scope

- Release automation, changesets, npm publishing — Phase 7
- Test coverage thresholds — meaningless before there is domain code
- Linting/formatting config — deliberately deferred; not worth the churn while
  the file set is this small
