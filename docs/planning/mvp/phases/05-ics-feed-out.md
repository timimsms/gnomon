# Phase 5 — ICS feed out

**Status:** 🚧 Built and tested; the three-client verification is manual and outstanding
**Depends on:** Phases 1, 2, 3
**Decisions in play:** L10 (feed is a deliverable, not a stretch goal)

---

## Objective

Any calendar client that speaks `webcal://` can subscribe to a Gnomon calendar
— which buys Google, Apple, and Outlook interop without writing a single OAuth
integration.

Cheapest extensibility hook available, which is exactly why it is a deliverable
and not a stretch goal.

---

## Work items

### 5.1 Tokened feed URLs

Opaque, revocable, per-calendar. Feed tokens are **not** the JWTs from ADR-0004
— those are short-lived and minted by the host, whereas a feed URL is pasted
into a calendar client once and polled for years. Different lifetime, different
threat model, different table.

Requirements:
- No PII in the URL. Calendar clients leak URLs into logs, sync services,
  screenshots, and support tickets.
- Cryptographically random, not derived from the calendar ID.
- Revocable individually, so a leak does not force rotating every subscriber.
- Stored hashed, so a database read does not yield working feed URLs.

### 5.2 RFC 5545 serialisation

Reuses the Phase 1 serialiser — this phase adds no new ICS-generation logic,
and if it seems to need to, that logic belongs in `@gnomon/core`.

Feed-specific concerns: `X-WR-CALNAME`, `X-WR-TIMEZONE`, `PRODID`, and
`VTIMEZONE` blocks for every zone referenced.

### 5.3 Transport correctness

- `Content-Type: text/calendar; charset=utf-8`
- `Content-Disposition` with a sensible filename
- CRLF line endings and 75-octet folding (inherited from Phase 1.8)
- `ETag` + `Last-Modified`, with `If-None-Match` / `If-Modified-Since` → 304.
  Clients poll aggressively and unconditionally; 304s are the difference
  between free-to-operate and not.
- `Cache-Control` tuned so clients refresh but do not hammer

### 5.4 Rate limiting

The first genuinely public, unauthenticated-by-JWT surface. Per-token limits,
and a cap on expansion work per request.

Feeds need a bounded window too — a client subscribing "forever" must not
trigger an unbounded expansion. Pick an explicit rolling window (e.g. some
months back, a year forward) and document it, since subscribers will notice
where it ends.

---

## Exit criteria

- [ ] Subscribing from **Google Calendar, Apple Calendar, and Outlook** renders
      correctly, **including recurrences** — all three, tested by hand
- [x] Recurring events appear as `RRULE`s, not as expanded instances, so
      clients apply their own expansion and the feed stays small
- [x] Conditional requests return 304 — verified by hand at 0 bytes vs 1296
- [x] Revoking a token stops the feed on the next poll
- [x] A leaked feed URL grants access to one calendar and nothing else
- [~] Feed output round-trips through an INDEPENDENT parser (`node-ical`,
      not our serialiser). The external online validator remains manual.

---

## Verification

Manual subscription from all three clients is a required part of the exit —
these clients disagree in practice and none of the disagreements show up in a
unit test. Record what was tested and on which client versions.

---

## Two findings

**`feed_tokens` is under RLS, and the feed request has no tenant.** The same
chicken-and-egg as `tenant_keys`: the policy reads `gnomon.tenant_id`, which
is precisely what the token lookup is trying to discover, so a plain `SELECT`
matches zero rows and every feed 404s. Unlike `tenant_keys` — excluded from
RLS entirely — this one gets a narrow `SECURITY DEFINER` function that takes a
token *hash* and returns only its tenant and calendar. The table keeps its
policy for listing, creating and revoking. Removing the function turns 15
tests red.

**Postgres renders `timestamp` with a SPACE, not a `T`.** `2026-03-01
09:00:00`, not ISO. Temporal accepts the space, so every path that *expands*
an event normalised it invisibly and nothing noticed for three phases. The
feed is the first path that serialises a **stored** value without expanding
it, and there `compactDateTime` split on `T`, found none, and emitted
`20260301 09:00:00T000000` — which no calendar client can read. Normalised at
the row boundary so the domain type means what it says everywhere.

---

## Still to do, and it needs a human

The exit criteria require subscribing from **Google Calendar, Apple Calendar
and Outlook** and confirming all three render correctly including recurrences.
These clients disagree in practice and none of the disagreements show up in a
unit test, which is exactly why the criterion is written that way. `pnpm
db:seed` prints a `webcal://` URL for this purpose.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Feed URL leakage | Medium | Opaque, hashed, individually revocable, no PII, rate limited. |
| The three clients disagree about `VTIMEZONE` or folding | Medium | Manual testing is in the exit criteria for exactly this reason. |
| Aggressive polling becomes the dominant operating cost | Medium | Conditional GET, cache headers, per-token rate limits. |

---

## Out of scope

- ICS **ingest** (Phase 7) — different direction, different failure modes
- CalDAV — a protocol, not a feed; explicitly not v0.1
- Per-subscriber feed personalisation
