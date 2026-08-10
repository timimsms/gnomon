# ADR-0004: Gnomon has no user accounts

**Status:** Accepted
**Date:** 2026-08-09
**Relates to:** L5, L7, O2

## Context

Gnomon embeds into someone else's portal. The people looking at the calendar —
a resident, a nurse, a teacher, a field technician — are already authenticated
by that portal. They have an account there.

The default instinct is to give them an account here too, so the calendar knows
who they are. That instinct is what makes "free add-on" economically false.
User accounts drag in registration, password reset, email delivery,
verification, session management, account recovery, an admin surface to
support all of it, and the security obligations of storing credentials for
people who never asked to have an account with us.

That is most of a product. It is also most of the operating cost, and nearly
all of the support burden, for a thing we intend to give away.

## Decision

**Gnomon stores no credentials and has no login.**

The host portal's backend mints a short-lived JWT and hands it to the embed:

```
{
  "iss":  "<tenant key id>",
  "aud":  "gnomon",
  "sub":  "<opaque subject id, host's own user id>",
  "tid":  "<tenant id>",
  "cal":  ["<calendar id>", ...],
  "scp":  ["events:read", "events:write"],
  "exp":  <now + 5 minutes>
}
```

Gnomon verifies the signature, extracts `tid`, and sets it as a Postgres
session variable that row-level security policies read. Tenancy is therefore
enforced by the database, not by remembering to add a `WHERE` clause.

`sub` is opaque. We never learn a name or an email address unless the host
chooses to put one in an event title.

Token TTL is short (~5 minutes) with silent refresh from the host. Signing
algorithm is **O2**, still open.

## Consequences

- **Integrators must run backend code.** A purely static site cannot embed
  Gnomon safely, because minting requires a secret. This is a real loss of
  reach and it is the correct trade: the alternative is a public write
  endpoint. Documented prominently in the quickstart.
- We inherit the host's authorisation model wholesale. If their portal has a
  permissions bug, we faithfully reproduce it. Acceptable — we are a view onto
  their data, not an authority over it.
- Scope enforcement lives in one middleware and one set of RLS policies. The
  Phase 2 exit criterion is an integration test proving tenant A cannot read
  tenant B's events **even with a forged calendar ID**, because RLS makes that
  test meaningful rather than a test of our own `WHERE` clauses.
- Support burden approaches zero for the largest category of user-facing
  problems (I can't log in / I didn't get the email / reset my password). Those
  are the host's, as they should be.
- Revocation is TTL-based rather than session-based. A leaked token is valid
  for its remaining lifetime. Short TTLs make this tolerable; per-tenant key
  rotation handles the serious case.

## Alternatives considered

**Full accounts with SSO/OIDC into the host.** More capable, and the right
answer if Gnomon ever becomes a destination rather than an embed. It is not
one, and building for that future now costs the thing that makes this project
worth doing.

**Anonymous public calendars only.** Simplest possible, and sufficient for the
"community events board" case — which is already well served by
`open-web-calendar`. It cannot express "show *this resident* *their* unit's
maintenance schedule," which is the case that has no good open-source answer.

**API keys per host, no per-user token.** Simpler for integrators, but then
every embed on a page carries a long-lived credential scoped to the whole
tenant, sitting in the browser. Non-starter.
