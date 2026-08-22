# Contributing

## Setup

```bash
pnpm install
pnpm --filter @gnomon/embed exec playwright install chromium
pnpm test
```

You also need a **Postgres 17** running somewhere. Any source works —
Postgres.app, `brew services start postgresql@17`, or
`docker compose up -d postgres` (which maps 5433). The suites find one
automatically via `GNOMON_TEST_DATABASE_URL`, then a local server on 5433 or
5432, and skip with an explanation if there is none.

Skipping is a local convenience only. **In CI those suites fail rather than
skip**, because a green build that never ran the tenancy tests is worse than a
red one.

## Before you open a PR

CI runs, in this order:

1. `pnpm lint:licenses` — dependency licence compliance
2. `pnpm typecheck`
3. `pnpm test` — which builds first, because the server serves built assets
   from disk

The licence gate runs first on purpose. A copyleft dependency is a licensing
incident, not a test failure, and it should fail before anything slower does.

CI also provisions a `postgres:17` service container and Playwright's
Chromium, so the database and browser suites run for real.

## Adding a dependency

Gnomon is MIT and must stay installable without legal review. If your
dependency is not under a permissive licence already in the allowlist in
`scripts/check-licenses.mjs`, the build fails — and the fix is not to edit the
allowlist. Open an ADR first.

This is not hypothetical. Adding Vite once pulled in `lightningcss` (MPL-2.0)
because Vite 8 had promoted it from an optional peer to a hard dependency.
Nobody chose a copyleft package; a dependency's dependency *structure* changed
between majors. Pinning Vite 7 fixed it without weakening the gate, which is
the outcome the gate exists to produce.

Prefer no dependency. `packages/core` in particular should stay close to
dependency-free so it runs unchanged in Node and the browser.

## Testing

The habit that has caught the most bugs in this project, by a wide margin:

### Prove the test can fail

After writing a test that passes, **break the thing it tests and watch it go
red.** If it does not, the test is not testing what you think.

This has repeatedly mattered here. An adapter's `destroy()` idempotency test
passed with the guard removed, because the test harness's own optional
chaining short-circuited first — the harness was testing itself. A
`setEvents` test passed for the wrong reason. A licence gate that never
rejected anything would have looked identical to one that worked.

When a control is security-relevant, do this as a matter of course and say so
in the PR.

### Derive expectations from the spec, not from the output

The recurrence conformance corpus in `packages/core/test/fixtures` gets its
expected values from RFC 5545 and from reasoning about the calendar — never
from running our own code and pasting the result. A corpus regenerated from
the code it tests proves only that the code is deterministic.

That corpus has since caught defects in a recurrence library, a schema
generator, and a database driver — none of which it was written to test.

### Assert on behaviour, not on text

A calendar can render every event title correctly while being completely
unstyled and unusable. Text assertions passed for weeks in exactly that state.
Where layout matters, assert computed layout.

### Recurrence and timezone code gets a fixture, always

"It looked right in the browser" is not evidence.

## Decisions

Locked decisions live in [`docs/decisions/README.md`](docs/decisions/README.md).
They can be overturned, but by a superseding ADR — not by a quiet diff. If a
PR contradicts a locked decision, say so in the description and expect the ADR
conversation first.

Open decisions are listed with the phase they block. If you hit one, don't
guess: resolve it in the ledger.

ADRs here record what was *rejected* and why, not only what was chosen. That
is the part which is expensive to reconstruct later.

## Style

- Comments explain *why*, not *what*. If a line needs a comment to say what it
  does, rewrite the line.
- Write down the consequence you accepted. "Rate limiting is per-process, so
  with N processes the effective limit is N times higher" is worth a comment;
  a future reader will otherwise treat it as a quota and be wrong.
- Prefer a narrower interface over a general one. If the renderer adapter
  cannot express something, the answer is usually to drop the feature rather
  than widen the interface — widening it is an ADR-level change
  ([ADR-0003](docs/decisions/0003-renderer-adapter.md)).
