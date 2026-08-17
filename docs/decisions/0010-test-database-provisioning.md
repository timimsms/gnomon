# ADR-0010: Tests take a Postgres URL, not a Docker daemon

**Status:** Accepted
**Date:** 2026-08-16
**Relates to:** L8, Phase 2.3, Phase 2.6
**Amends:** Phase 2.6, which specified testcontainers

## Context

Phase 2's exit criteria are unprovable without a real Postgres: row-level
security cannot be tested against a mock, and testing it against a superuser
connection passes while proving nothing.

The phase plan named **testcontainers**. Testcontainers hard-requires a Docker
daemon, and Docker is unavailable on the development machine and expected to
stay that way for some time. The phase stalled behind it.

That turned out to be a dependency we had inherited rather than chosen. The
actual requirement is *a real Postgres*. Testcontainers is one way to obtain
one; it is not the only way, and it was never the interesting part.

Two facts made the alternative obvious once looked for:

- **Postgres 17.7 was already running on the development machine** (Postgres.app,
  port 5432), with superuser access. It is the same major version as
  `postgres:17-alpine` in `docker-compose.yml`. RLS, `FORCE ROW LEVEL
  SECURITY`, role creation and policy behaviour were all verified against it
  directly.
- **GitHub Actions runs service containers natively.** CI needs no Docker
  daemon on any contributor's machine to get a real Postgres.

So the constraint "Docker is unavailable locally" never actually blocked
*verification*. It only blocked one particular way of provisioning.

## Decision

**The test harness takes a connection URL and does not care where it came
from.** It resolves, in order:

1. `GNOMON_TEST_DATABASE_URL` — CI, or a deliberate local choice
2. a Postgres already listening on 5433 (compose's mapped port) or 5432
3. nothing — skip locally with an explanatory message, **fail in CI**

Each suite creates a scratch database, applies the checked-in migrations, and
creates an application role that is not a superuser, owns nothing, and has no
`BYPASSRLS`. Every tenancy assertion runs through that role.

CI uses a `postgres:17-alpine` service container.

`docker compose up -d postgres` remains supported and is simply one of the
three sources. **Testcontainers can be reintroduced whenever Docker returns**;
it only ever produced a URL, and nothing in the harness would change.

## Consequences

- Phase 2 is verifiable today rather than whenever Docker is fixed. The
  headline exit criterion — tenant A cannot read tenant B's events even with a
  forged calendar ID — is proven, not deferred.
- **A contributor needs *some* Postgres.** This is the real cost. It is
  mitigated by accepting any of three sources and by a skip message that names
  all of them, and bounded by CI failing rather than skipping, so the
  guarantee is always kept somewhere even if a laptop cannot keep it.
- Running against whatever Postgres is local means version drift is possible.
  CI pins 17 and is the authority; local is a convenience. The alternative —
  an auto-downloading embedded Postgres — was considered and rejected below.
- A fresh database per suite rather than a shared one with cleanup, because
  RLS behaviour depends on table ownership and role membership, and those are
  exactly what a half-cleaned database gets wrong.
- The harness applies the **checked-in migration files**, not re-derived DDL.
  A migration that would fail in production therefore fails in tests first —
  which is not hypothetical: see below.

## What applying the migration immediately caught

The initial schema had never been executed against a real Postgres, only
generated. It did not work.

```
error: there is no unique constraint matching given keys for referenced table "calendars"
```

`drizzle-kit` emits every `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY`
*before* any `CREATE UNIQUE INDEX`. The composite foreign keys pointed at a
unique **index** that did not exist yet at the moment the constraint was added.
Postgres does accept a unique index as a foreign-key target — verified
separately — so this was purely an ordering fault, and the fix was to declare
those two targets as UNIQUE **constraints**, which are inline in `CREATE TABLE`.

This is the second time in this phase that generated output was wrong in a way
typecheck could not see, after `drizzle-kit` silently discarding raw `sql`
foreign keys. Both argue the same thing: generated SQL is not evidence until
it has been run.

## Alternatives considered

**Keep testcontainers and wait for Docker.** No deviation from the plan, and
an indefinite stall on a security boundary while a working Postgres 17 sat
running on the machine.

**`embedded-postgres` (auto-downloading binaries).** Genuinely attractive:
hermetic, version-pinned, works on a bare machine with nothing installed.
Rejected for now on two counts — the package's newest release is
`18.4.0-beta.17`, and a beta on the test path of a security boundary is a poor
trade; and it pins Postgres 18 while we deploy 17. Worth revisiting if
contributor friction proves real, and the harness would not change: it would
become a fourth source of a URL.

**PGlite (Postgres compiled to WASM, in-process).** Rejected on a specific
technical ground rather than taste: it runs single-user as the superuser, and
a superuser bypasses RLS unconditionally. It cannot express the one thing
these tests exist to prove.
