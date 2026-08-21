# Gnomon

An embeddable, multi-tenant calendar service that platform companies can offer
to their end users for free.

> A gnomon is the shadow-casting pin on a sundial — the part that turns time
> into something you can read off a surface.

**Status: pre-release.** Phases 0–6 of 7 are complete: recurrence expansion,
tenancy, auth, the read and write APIs, the embed surface, and ICS feeds all
work and are tested. Phase 7 — ICS ingest, accessibility, docs — is
outstanding, so there is no tagged release yet. See
[`docs/decisions`](docs/decisions/README.md) for what's locked, and
[what still needs a human](#what-still-needs-a-human).

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

---

## How an integrator uses it

One backend endpoint and one script tag. That is the whole integration.

Your backend mints a short-lived token for the user it has already
authenticated ([ADR-0004](docs/decisions/0004-host-minted-tokens.md) — Gnomon
has no accounts and never learns who your users are):

```js
// See examples/token-minting for copy-pasteable Node and Go versions,
// both zero-dependency.
app.get('/api/gnomon-token', (req, res) => {
  res.json({ token: mintToken({ subject: req.user.id, calendars: [...] }) });
});
```

Your page pastes one tag:

```html
<script src="https://gnomon.example.com/embed.js"
        data-gnomon-api="https://gnomon.example.com"
        data-gnomon-token-endpoint="/api/gnomon-token"
        data-gnomon-calendars="cal-maintenance,cal-community"
        defer></script>
```

The loader is **1.3 KB gzipped** with no dependencies, so you can read all of
it before trusting it. It renders in the page by default and falls back to an
iframe if your CSP refuses.

---

## Running it locally

Requires **Node 22+**, **pnpm 9**, and a **Postgres 17**. Any Postgres will do
— Postgres.app, Homebrew, or `docker compose up -d postgres`
([ADR-0010](docs/decisions/0010-test-database-provisioning.md)).

```bash
pnpm install

export DATABASE_URL="postgres://localhost/gnomon"
pnpm --filter @gnomon/server db:bootstrap   # create + migrate + seed
pnpm --filter @gnomon/server start          # http://localhost:3000
```

`db:bootstrap` creates the database if it is missing, applies the migrations
and seeds a demo tenant. It goes through the `pg` client rather than shelling
out to `createdb`, which is not reliably on `PATH` — a Postgres.app install
is keg-only, and a quickstart whose first command is "not found" is worse than
no quickstart.

The seed prints a ready-to-run `curl` and a `webcal://` URL you can add to a
calendar client. Its demo events are chosen to be worth looking at: a weekly
inspection crossing the US spring-forward, and a floating all-day holiday.

To see the embed inside a host page, run the reference portal alongside it:

```bash
pnpm --filter @gnomon/demo-portal start  # http://localhost:4000
```

### Running the tests

```bash
pnpm test        # builds first, then runs every suite
```

Suites needing a real Postgres find one automatically
(`GNOMON_TEST_DATABASE_URL`, then a local server on 5433 or 5432) and **skip
with an explanation** if there is none — except in CI, where they fail rather
than skip. Browser suites need Playwright's Chromium once:

```bash
pnpm --filter @gnomon/embed exec playwright install chromium
```

---

## Layout

```
packages/
  core/          domain types, recurrence expansion, ICS interop — no I/O
  embed/         Lit web component + renderer adapters
  loader/        the <script> tag payload, size-budgeted
apps/
  server/        Hono API, Drizzle schema, RLS policies
  demo-portal/   reference host integration; doubles as the hostile-host target
examples/
  token-minting/ zero-dependency Node and Go reference implementations
```

`packages/core`'s main entry is I/O-free on purpose: it runs identically on
the server and in the browser, and its suite is fast enough that nobody skips
it. ICS parsing is the one exception, behind a Node-only subpath
([ADR-0008](docs/decisions/0008-ics-parsing-is-a-node-only-subpath.md)).

Both server and browser use `temporal-polyfill`
([ADR-0006](docs/decisions/0006-temporal-acquisition.md)) — Node 26 does not
expose `Temporal` natively, despite what the original plan assumed.

---

## Roadmap

Phase specifications, with exit criteria, live in
[`docs/planning/mvp/phases`](docs/planning/mvp/phases/README.md).

| Phase | Scope | Status |
|---|---|---|
| 0 | Foundation, licence gate, CI | ✅ done |
| 1 | Core domain, recurrence expansion, conformance corpus | ✅ done |
| 2 | Tenancy, RLS, token auth | ✅ done |
| 3 | Read API | ✅ done |
| 4 | Embed surface, renderer adapters | ✅ done |
| 5 | ICS feed out | ✅ built — three-client check outstanding |
| 6 | Write path (non-recurring events only) | ✅ done |
| 7 | ICS in, accessibility, docs, v0.1.0 | ⬜ next |

### What still needs a human

Two exit criteria cannot be met by writing more code:

- **Subscribing to a feed from Google, Apple and Outlook** and confirming all
  three render recurrences correctly. These clients disagree in practice and
  none of the disagreements show up in a unit test. Google fetches
  server-side, so it needs a publicly reachable URL rather than `localhost`.
- **`docker compose up` producing a working calendar in under two minutes on a
  cold machine.** Docker is not installed on the current development machine,
  and this is a Phase 7 exit criterion.

---

## Known limitations in v0.1

Decisions, not defects, and each has an ADR:

- **Recurring events are read-only.** They are stored, expanded and served
  correctly; they cannot be created or edited. "This / this and following /
  all" is where calendar projects die (L4).
- **You must run backend code.** Minting requires a private key, so a purely
  static site cannot embed Gnomon safely
  ([ADR-0004](docs/decisions/0004-host-minted-tokens.md)).
- **Expansion windows are capped** at 400 days, with a separate cap on
  occurrence count ([ADR-0007](docs/decisions/0007-expand-on-read.md)).
- **Feed rate limiting is per-process.** With N server processes the effective
  limit is N times higher. It bounds abuse; it is not a quota.

---

## Licence

MIT. Dependencies are permissive-only and enforced in CI — see
[ADR-0002](docs/decisions/0002-permissive-dependencies-only.md) and
`scripts/check-licenses.mjs`.
