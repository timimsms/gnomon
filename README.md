# Gnomon

An embeddable, multi-tenant calendar service that platform companies can offer
to their end users for free.

> A gnomon is the shadow-casting pin on a sundial — the part that turns time
> into something you can read off a surface.

**Status: pre-alpha.** Phase 0 of 7 complete. Not usable yet. See
[`docs/decisions`](docs/decisions/README.md) for what's locked and what's
still open.

---

## What this is

You run a portal — for residents, patients, students, technicians, members.
You'd like to give those people a calendar. Your options today are:

- **A renderer** (FullCalendar, Schedule-X, `@event-calendar`) — draws a grid,
  but brings no backend, no tenancy, no auth, no persistence.
- **A booking system** (Cal.com) — excellent, but shaped around *scheduling a
  meeting with someone*, not *showing someone their schedule*.
- **Commercial calendar infrastructure** (Cronofy, Nylas) — priced per seat or
  per connected account, which does not survive the sentence "we give this to
  every resident for free."

Gnomon is the missing middle: the tenancy, the token-scoped embed auth, the
recurrence correctness, and the ICS interop — with a renderer plugged in behind
an adapter.

## What this is not

Not a booking or availability engine. Not a Calendly alternative. Not another
calendar renderer. Not a Google Calendar replacement.

## Quickstart

Requires Node 22+ (the server package will require 26+ for native Temporal),
pnpm 9, and Docker.

```bash
pnpm install
pnpm db:up      # Postgres 17 on :5433
pnpm test
```

## Layout

```
packages/
  core/          domain types, recurrence expansion, ICS interop — no I/O
  embed/         Lit web component + renderer adapter
  loader/        the <script> tag payload
apps/
  server/        Hono API, Drizzle schema, pg-boss jobs
  demo-portal/   reference host integration; doubles as the CSP/e2e target
```

`packages/core` is I/O-free on purpose: it must run identically on the server
(native Temporal) and in the browser (polyfilled), and its test suite has to be
fast enough that nobody skips it.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Foundation, license gate, CI | ✅ done |
| 1 | Core domain, recurrence expansion, conformance corpus | next |
| 2 | Tenancy, RLS, token auth | |
| 3 | Read API | |
| 4 | Embed surface, renderer adapters | |
| 5 | ICS feed out | |
| 6 | Write path (non-recurring events only) | |
| 7 | ICS in, accessibility, docs | |

## License

MIT. Dependencies are permissive-only and enforced in CI — see
[ADR-0002](docs/decisions/README.md) and `scripts/check-licenses.mjs`.
