# Phase 3 — Read API

**Status:** ✅ Complete
**Depends on:** Phases 1 and 2
**Blocks:** Phases 4, 5
**Decisions in play:** L4 (read-mostly), O4 (expand on read)

---

## Objective

A curl-able, token-authenticated HTTP surface that returns expanded occurrences
for a bounded window — the first point at which the system is usable by
something other than a test.

Small phase. Both hard parts (correct expansion, enforced tenancy) are already
done; this is the seam between them.

---

## Work items

### 3.1 Endpoints

```
GET /calendars
GET /calendars/:id
GET /events?from&to&tz&calendarId
```

`/events` returns occurrences expanded by `@gnomon/core`, not stored rows. The
`tz` parameter controls the timezone occurrences are *rendered in*, and must
not be confused with the timezone the rule is *anchored to* — Phase 1's
cross-timezone fixtures cover the distinction and the API must preserve it.

Window bounds route through `assertWindow`. A request exceeding
`MAX_WINDOW_DAYS` returns **400 with a machine-readable error naming the cap**,
not a 500 and not a silent truncation.

### 3.2 Zod request/response schemas

Shared between the API contract and (in Phase 4) the embed config, per the
stack decision. One definition, two consumers.

### 3.3 ETag and conditional GET

Cheap, and it matters: an embed-heavy portal page may mount several calendars,
and a portal that polls is the common case. ETag over the expanded response
plus `If-None-Match` → `304`.

The ETag must incorporate everything that varies the response — window,
timezone, calendar set, *and* the tenant — or a shared cache will serve one
tenant's data to another. This is a tenancy bug wearing a caching costume, and
it needs its own test.

### 3.4 OpenAPI spec generated from Zod

Generated, not hand-maintained; a hand-maintained spec is wrong within a month.
Serve it, and use it as the integration quickstart's source of truth.

### 3.5 Seeded demo tenant

A demo tenant with calendars that exercise the interesting cases — at minimum a
recurring event crossing a DST boundary and an all-day event — so that
`docker compose up` produces something worth looking at, and so the Phase 4
embed has data on day one.

---

## Exit criteria

- [x] Curl-able API against the demo tenant, with a token minted by the
      reference implementation
- [x] Over-wide window returns 400 naming the cap
- [x] `If-None-Match` returns 304, and the ETag varies by tenant — proven by a
      test that two tenants with identical query parameters get different ETags
- [x] OpenAPI spec generated from Zod and served
- [x] Expansion results match the Phase 1 corpus when fetched over HTTP —
      the API must not re-implement or post-process expansion

---

## Verification

```bash
docker compose up -d
curl -H "Authorization: Bearer $(node scripts/mint-demo-token.mjs)" \
  'http://localhost:3000/events?from=2026-03-01&to=2026-03-31&tz=America/New_York'
```

---

## Two defects this phase surfaced

Both were found by making the API query through the index and compare against
the corpus, rather than by reasoning about the code.

**`pg` returns `date` and `timestamp` columns as JS `Date` objects.** For this
schema that is a correctness bug, not a typing inconvenience: a `date` holds a
*floating* date (ADR-0005), so constructing a `Date` from it anchors it to the
server's timezone and a holiday stored as 2026-10-03 renders on 2026-10-02
anywhere west of Greenwich. The same hazard the ICS parser hit, arriving from
the other direction. Type parsers for OIDs 1082 and 1114 are registered in
`db/client.ts`; removing them turns 30 tests red.

**A zero-duration event produced an EMPTY `tstzrange`.** `[t,t)` overlaps
nothing in Postgres, so the GiST pre-filter silently dropped the event and it
was missing from every query with no error anywhere. The span is now widened
to a millisecond when it would be empty — always safe, since it need only be a
superset. Phase 1's zero-length fixture is what exposed it, once there was an
index for it to be filtered by.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| ETag not tenant-scoped ⇒ cross-tenant cache leak | **High** | Dedicated test; include tenant in the hash input. |
| Expansion drifts from `@gnomon/core` via API-layer post-processing | Medium | The API calls core and serialises; any transformation belongs in core. |
| `tz` conflated with the rule's anchor timezone | Medium | Covered by Phase 1 fixtures, asserted again at the HTTP layer. |

---

## Out of scope

- Writes of any kind (Phase 6)
- The ICS feed representation (Phase 5)
- Pagination — the window cap bounds response size; revisit if it proves wrong
- Rate limiting — arrives with the public feed surface in Phase 5
