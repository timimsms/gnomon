# Phase 6 — Write path

**Status:** ✅ Complete
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

- [x] A scoped token creates an event; an unscoped one gets 403, proven by test
- [x] A token scoped to calendar A cannot write to calendar B in the same
      tenant, proven by test
- [x] Writing an event with an `RRULE` returns a specific, documented 4xx
- [x] Every mutation appears in the audit log; the application role cannot
      `UPDATE` or `DELETE` audit rows
- [x] Concurrent conflicting updates produce 409, not a lost write
- [x] Written events round-trip through the Phase 5 ICS feed unchanged

---

## Verification

```bash
pnpm --filter @gnomon/server test
```

---

## Notes from building it

**Concurrency needed a column, not a timestamp.** `updated_at` defaults to
`now()`, which inside a transaction is the *transaction start* time — so two
concurrent updates beginning in the same instant carry identical timestamps,
and an `If-Match` built on that lets one overwrite the other while both
believe they hold the current version. A monotonic `version` has no such tie.
`xmin` was the other candidate and was rejected: it wraps around, is not
portable, and would put a Postgres system column in our public API.

`SELECT ... FOR UPDATE` matters as much as the comparison. Without the lock,
two writers can both read version 3, both find `If-Match` satisfied, and both
write version 4 — which is precisely the lost update the endpoint exists to
prevent.

**Deletions are audited before the row is gone.** Afterwards there is nothing
left to record, and an audit log that omits deletions is worse than none.

**Append-only is a GRANT, not a convention.** The application role holds
`SELECT, INSERT` on `audit_log` and nothing else, so a compromised application
cannot rewrite its own history whatever the code says. The test asserts
`permission denied` rather than trusting the absence of a code path.

All three controls were verified by removing them: dropping the per-calendar
scope check lets a token write to a calendar it was never granted, dropping
the `If-Match` comparison loses a write silently, and skipping the audit
insert leaves a mutation unrecorded.

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
