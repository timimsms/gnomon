# Embeddable Portal Calendar — MVP Gameplan

**Working name:** Gnomon (O1, closed)
**Status:** ⚠️ **Historical.** This is the original scoping document, kept as
the record of why the project is shaped the way it is. It has NOT been edited
to match what was built.

---

## Read this first

For current state, go to:

- [`phases/README.md`](phases/README.md) — phase specifications and exit
  criteria, kept up to date
- [`../../decisions/README.md`](../../decisions/README.md) — the live decision
  ledger, including every ADR

**Four things below are now known to be wrong**, and are worth knowing about
before trusting anything else on this page:

| Claim here | What is actually true |
|---|---|
| L6: "Server runs native [Temporal]" on Node 26+ | Node 26.3.0 exposes no `Temporal` at all, with or without `--harmony-temporal`. Both server and client use `temporal-polyfill` ([ADR-0006](../../decisions/0006-temporal-acquisition.md)) |
| L10: "ICS feed out is a **Phase 4** deliverable" | It landed in Phase 5; the phase numbering here drifted from the ledger's |
| O1 (name) and O3 (design partner) listed as open | Both closed before Phase 0 — Gnomon, and no design partner (L11) |
| Testing: "API contract — Vitest + testcontainers" | Testcontainers requires a Docker daemon, which is the dependency it was chosen to avoid depending on. Replaced by a URL-based harness ([ADR-0010](../../decisions/0010-test-database-provisioning.md)) |

The rest — the thesis, the market gap, the ordering argument, the non-goals
and the risk register — has held up, including the prediction that Phases 1
and 4 would be the ones that overran.

---

## 1. Thesis

The market has three tiers and a hole in the middle.

| Tier | Examples | What it gives you | What it doesn't |
|---|---|---|---|
| Renderers | `@event-calendar`, FullCalendar, Schedule-X | A grid | No backend, tenancy, auth, or persistence |
| Full systems | Cal.com, open-web-calendar | A working app | Booking-shaped or read-only single-tenant |
| Commercial infra | Cronofy, Nylas | Sync + availability | Priced per seat / per connected account |

**The gap:** a multi-tenant, embed-into-someone-else's-portal calendar service with a permissive license and near-zero marginal cost per embed.

**The product is not another renderer.** Drawing a calendar grid is solved. The value is tenancy, tokened embed auth, recurrence correctness, ICS interop, and a clean extension surface.

**Corollary that shapes the architecture:** two of the four leading renderers moved features behind a paywall in the last eight months (Schedule-X v4 moved drag-and-drop + resize to Premium in Jan 2026; FullCalendar v7 tightened Premium copyleft from GPLv3 to AGPLv3 in June 2026). The renderer is a commodity that can turn hostile. It goes behind an adapter on day one.

---

## 2. Decision Ledger

### Locked (proposed defaults — confirm or overturn before Phase 0)

| # | Decision | Rationale |
|---|---|---|
| L1 | **MIT license** | Adoption is the entire point of a free portal add-on. AGPL would deter the exact integrators we're courting. |
| L2 | **Zero premium/copyleft dependencies, ever** | One AGPL dep (e.g. FullCalendar Premium) forces AGPL on the whole project. This is a hard CI gate, not a guideline. |
| L3 | **`@event-calendar` (vkurko) as launch renderer, behind an adapter** | MIT, zero-dependency standalone bundle, resource + timeline views free, actively maintained (Svelte 5 rewrite through 2026), FullCalendar-compatible option naming. Most generous free tier with no premium plugins to accidentally depend on. |
| L4 | **Read-mostly v0.1**: full read incl. recurrence expansion; write limited to non-recurring events | Recurrence *editing* UX ("this / this and following / all") is where calendar projects die. Store and expand recurrence in v0.1; defer editing it. |
| L5 | **No user accounts in the calendar system** | Host portal's backend mints a short-lived signed JWT. We inherit their identity. No login, no password reset, no email delivery. This is what makes free-to-embed economically real. |
| L6 | **Temporal + `temporal-polyfill`** | Stage 4 / ES2026 as of March 2026; native in Chrome 144+, Firefox 139+, Edge 144+, Node 26+. Safari is the sole holdout, so polyfill on the client. Server runs native. |
| L7 | **Shared instance, row-level tenancy via Postgres RLS** | Tenant derived from JWT claim, injected as a session variable. One deployment serves N portals. Single-tenant deploys remain possible but aren't the default. |
| L8 | **Single container + Postgres. No Redis, no queue broker.** | Job scheduling via `pg-boss` (Postgres-backed). Infra floor is the product's competitive moat. |
| L9 | **TypeScript end-to-end, pnpm monorepo** | One language lowers the OSS contribution barrier. Recurrence logic is shared between server expansion and client preview. |
| L10 | **ICS feed out is a Phase 4 deliverable, not a stretch goal** | Cheapest possible extensibility hook. Buys Google/Apple/Outlook subscription without writing a single OAuth integration. |

### Open (block specific phases)

| # | Question | Blocks | Notes |
|---|---|---|---|
| O1 | Project name + npm scope | Phase 0 | Needs to not collide with `@event-calendar`, `calendar-embed`, etc. |
| O2 | JWT signing: HS256 per-tenant shared secret vs. EdDSA + JWKS | Phase 2 | HS256 ships faster; EdDSA avoids secret distribution and scales to self-serve onboarding. Recommend EdDSA if we expect >10 integrators. |
| O3 | Is Nomad design partner #1, or is the first consumer hypothetical? | Phase 1 scope | Real constraints produce a sharper spec but bias toward property management. |
| O4 | Do occurrences get materialized or expanded on read? | Phase 1 | Start expanded-on-read with a bounded window. Materialization is a cache decision, deferred until we have a slow query. |
| O5 | All-day event semantics across timezones | Phase 1 | Floating date vs. tenant-timezone-anchored. Affects the data model, so it must be answered inside Phase 1, not after. |
| O6 | Governance model (BDFL vs. contributor ladder) | Phase 7 | Only matters at the point we invite outside contributors. |

---

## 3. Tech Stack

### Server

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 26+ | Native Temporal, no server-side polyfill |
| HTTP | Hono | Tiny, web-standard `Request`/`Response`, runs on Node/Bun/Workers — keeps deploy targets open |
| DB | Postgres 17+ | RLS for tenancy, `tstzrange` + GiST for overlap queries, LISTEN/NOTIFY if we ever need it |
| ORM / migrations | Drizzle | SQL-first, typed, migration files readable in review — important for an OSS project where the schema is public API |
| Jobs | `pg-boss` | Postgres-backed. Zero additional infra for ICS polling and feed cache warming |
| Validation | Zod | Shared schemas between API contract and embed config |
| Auth | `jose` | JWT verify, JWKS support if O2 lands on EdDSA |
| Recurrence | `rrule-temporal` | MIT, RFC-5545 compliant, Temporal-native, returns `ZonedDateTime`. Purpose-built to fix cross-timezone recurrence, unlike `Date`-based `rrule.js` |
| ICS parse (in) | `node-ical` | RRULE expansion, EXDATE, RECURRENCE-ID overrides, Windows→IANA timezone mapping |
| ICS serialize (out) | Hand-rolled against RFC 5545 | Output is narrow and fully under our control; a dependency buys little and costs line-folding surprises |

### Client

| Concern | Choice | Why |
|---|---|---|
| Component model | Lit | ~5KB, real web component, Shadow DOM by default. Mounts into any host portal regardless of their framework |
| Renderer | `@event-calendar` behind `RendererAdapter` | See L3. Adapter interface is ~8 methods: mount, destroy, setEvents, setView, setDate, on(event), setTheme, refresh |
| Build | Vite → IIFE bundle + ESM | IIFE for the `<script>` tag path, ESM for integrators who want to bundle it |
| Dates | Temporal + `temporal-polyfill` | Feature-detected dynamic import so Chrome/Firefox users don't pay for Safari |
| Styling | CSS custom properties, pierced into Shadow DOM | Host portals theme via `--pcal-*` tokens. No Tailwind — we can't assume a host build pipeline |
| Loader | Hand-written, no deps, <2KB gzipped | Reads `data-*` attributes, fetches token, injects the component. This is the file every integrator pastes; it must be auditable in one sitting |

### Repo layout

```
packages/
  core/          # recurrence expansion, ICS in/out, domain types — no I/O
  embed/         # Lit web component + renderer adapter
  loader/        # the <script> tag payload
apps/
  server/        # Hono API, Drizzle schema, pg-boss jobs
  demo-portal/   # reference host integration; doubles as the CSP/e2e test target
```

`packages/core` having no I/O is deliberate — it makes the recurrence conformance suite fast and lets integrators reuse expansion client-side.

### Testing

| Layer | Tool | Notes |
|---|---|---|
| Unit | Vitest | |
| **Recurrence conformance** | Vitest + fixture corpus | **The single highest-value test asset in the project.** Golden-file fixtures covering DST spring-forward/fall-back, `BYDAY` with ordinals, `BYSETPOS`, `UNTIL` vs `COUNT`, EXDATE, RECURRENCE-ID overrides, leap years, cross-timezone `DTSTART`. Build this in Phase 1, before any UI exists. |
| API contract | Vitest + testcontainers | Real Postgres, real RLS |
| Embed integration | Playwright against `demo-portal` | Must include hostile scenarios: strict CSP, host CSS reset, host jQuery, iframe fallback path |

### Deploy

Single Docker image + Postgres. `docker compose up` must produce a working calendar with a seeded demo tenant in under two minutes, or the OSS adoption story fails at the first step.

---

## 4. Build Phases

Ordered so the riskiest, least-reversible work happens first and the demo-able work happens late. This is intentional and will feel wrong around Phase 2.

### Phase 0 — Foundation (~3 days)
- Repo scaffold, pnpm workspaces, TS config, CI
- LICENSE (MIT), CONTRIBUTING, ADR directory
- **License-compliance CI gate**: fail the build on any dependency not in an allowlist of permissive SPDX identifiers
- Docker compose with Postgres
- **Exit:** `pnpm install && pnpm test` green on a clean clone

### Phase 1 — Core domain (~1.5 weeks) ⚠️ highest risk
- Domain types: `Calendar`, `Event`, `EventOccurrence`, `RecurrenceOverride`
- Recurrence expansion service over `rrule-temporal`, bounded-window API
- Recurrence conformance fixture corpus (see Testing)
- Resolve **O5** (all-day semantics) here — it is a schema decision
- ICS parse + serialize round-trip
- **Exit:** `packages/core` expands a nasty real-world ICS file correctly across a DST boundary, with fixtures proving it

### Phase 2 — Tenancy + auth (~1 week)
- Drizzle schema, migrations, Postgres RLS policies
- JWT verification middleware; tenant + scope extraction into session context
- Resolve **O2**
- Token minting reference implementation (Node + one other language) for integrators
- **Exit:** an RLS-enforced integration test proving tenant A cannot read tenant B's events even with a forged calendar ID

### Phase 3 — Read API (~4 days)
- `GET /calendars`, `GET /events?from&to&tz` returning expanded occurrences
- ETag / conditional GET (cheap, and matters for embed-heavy pages)
- OpenAPI spec generated from Zod
- **Exit:** curl-able API with the demo tenant

### Phase 4 — Embed surface (~1.5 weeks)
- `RendererAdapter` interface + `@event-calendar` implementation
- Lit web component: month + agenda/list views only
- Loader script + `data-*` config contract
- Theme token system
- iframe fallback path
- Playwright hostile-host suite
- **Exit:** paste one `<script>` tag into `demo-portal` and see a themed, working calendar under strict CSP

### Phase 5 — ICS feed out (~4 days)
- Tokened opaque feed URLs, revocable, per-calendar
- Correct `Content-Type`, line folding, `X-WR-CALNAME`, cache headers
- **Exit:** subscribe from Google Calendar, Apple Calendar, and Outlook; all three render correctly including recurrences

### Phase 6 — Write path (~1 week)
- Create / update / delete for **non-recurring events only** (L4)
- Scope-gated by JWT claims
- Append-only audit table
- **Exit:** a scoped token can create an event; an unscoped one gets a 403, proven by test

### Phase 7 — ICS in + polish (~1.5 weeks)
- ICS source registration, `pg-boss` polling with ETag-conditional fetch
- Accessibility pass on the web component (keyboard nav, ARIA grid semantics, screen reader announcements on view change)
- Docs site, integration quickstart, token-minting cookbook
- **Exit:** v0.1.0 tagged

**Total: roughly 7–8 weeks of focused effort.** Phases 1 and 4 will each overrun; everything else is well-understood.

---

## 5. Explicit Non-Goals for v0.1

Naming these prevents scope drift more reliably than a roadmap does.

- Two-way Google / Microsoft OAuth sync
- Availability engine, booking, or scheduling links (that's Cal.com's shape, not ours)
- Resource and timeline views
- Recurrence *editing* UI
- Notifications, reminders, email of any kind
- Attachments or rich text on events
- Mobile native SDKs
- Multi-language / i18n beyond date formatting via `Intl`

---

## 6. Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| Recurrence + DST correctness | **High** | Conformance corpus in Phase 1, before UI exists. Non-negotiable ordering. |
| Renderer license drift | Medium | `RendererAdapter` from day one. A second adapter (FullCalendar Standard) as proof the seam works — build it in Phase 4, not later. |
| Host portal CSS / CSP hostility | Medium | Shadow DOM by default, iframe fallback, Playwright hostile-host suite |
| ICS feed URL leakage | Medium | Opaque revocable tokens, no PII in the URL, per-feed revocation UI, rate limiting |
| Temporal polyfill bundle weight | Low | Feature-detected dynamic import; cost falls to zero when Safari ships |
| "Free" turns out to mean expensive to operate | Low | Single container + Postgres, ETag-conditional everything, expansion window caps |

---

## 7. Immediate Next Actions

1. Confirm or overturn L1–L10
2. Answer O1 (name), O3 (design partner) — these block Phase 0 and Phase 1 scope respectively
3. If proceeding: generate the Phase 0 + Phase 1 handoff pack (schema draft, `RendererAdapter` interface, recurrence fixture manifest)
