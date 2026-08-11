# Phase 6 — Write path

**Status:** ⬜
**Depends on:** Phases 2, 3
**Decisions in play:** L4 (non-recurring writes only)

---

## Objective

A scoped token can create, update, and delete **non-recurring** events; an
unscoped one cannot, and the difference is proven by test rather than by
inspection.

---

## Work items

### 6.1 CRUD for non-recurring events only

```
POST   /calendars/:id/events
PATCH  /events/:id
DELETE /events/:id
```

L4 holds: recurring events are read-only in v0.1. "This / this and following /
all" is where calendar projects die, and shipping half of it is worse than
shipping none.

The rejection must be **explicit and specific**. An attempt to write an event
with an `RRULE`, or to modify an existing recurring event, returns a 4xx whose
message says recurrence editing is not supported in this version and points at
the documented limitation. A generic validation error here reads as a bug and
will be filed as one.

### 6.2 Scope gating

Enforced from the JWT's `scp` claim (ADR-0004). `events:write` is required;
absent, 403.

Scope must be checked against the **specific calendar** being written to, not
merely the tenant — a token scoped to calendar A must not write to calendar B
in the same tenant. RLS enforces the tenant boundary; the calendar boundary is
the middleware's job, and RLS will not catch it.

### 6.3 Append-only audit table

Every mutation records: tenant, subject (`sub` — opaque, per ADR-0004),
calendar, event, operation, timestamp, and the before/after state.

Append-only in practice, not only in intent: no `UPDATE` or `DELETE` grant to
the application role.

Since we never learn who `sub` is, the audit log is only meaningful when joined
against the host's own records. Say so in the documentation, so integrators
keep the mapping they will eventually need.

### 6.4 Concurrency control

Two portal tabs editing one event must not silently lose a write. `If-Match`
against the event's ETag/version, `409` on mismatch.

---

## Exit criteria

- [ ] A scoped token creates an event; an unscoped one gets 403, proven by test
- [ ] A token scoped to calendar A cannot write to calendar B in the same
      tenant, proven by test
- [ ] Writing an event with an `RRULE` returns a specific, documented 4xx
- [ ] Every mutation appears in the audit log; the application role cannot
      `UPDATE` or `DELETE` audit rows
- [ ] Concurrent conflicting updates produce 409, not a lost write
- [ ] Written events round-trip through the Phase 5 ICS feed unchanged

---

## Verification

```bash
pnpm --filter @gnomon/server test
```

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Scope check covers tenant but not calendar | **High** | Dedicated test; RLS does not cover this. |
| Write path accepts an `RRULE` and stores something it cannot expand | Medium | Explicit rejection at validation, tested. |
| Audit log mutable in practice | Medium | Enforce by grant, not by convention. |

---

## Out of scope

- Recurrence editing in any form (L4)
- Bulk import (Phase 7, via ICS ingest)
- Attachments, rich text (explicit non-goals)
- Write support in the embed UI — the API is the deliverable here
