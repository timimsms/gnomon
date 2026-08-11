# Phase 2 — Tenancy and auth

**Status:** ⬜
**Depends on:** Phase 1 (the schema encodes Phase 1's timing model)
**Blocks:** Phases 3–7
**Decisions in play:** L5 (no accounts), L7 (RLS tenancy), L8 (Postgres only)
**Must close:** **O2** (JWT signing algorithm)

---

## Objective

Tenancy is enforced by the database rather than by remembering to write a
`WHERE` clause, and identity arrives from the host portal as a short-lived
signed token that we verify but never issue.

This is a security boundary. It is built before there is an API to protect,
because boundaries retrofitted around existing code leak at exactly the places
that code already exists.

---

## Decisions to close

### 2.1 O2 — JWT signing algorithm

**HS256 with a per-tenant shared secret** ships faster and is trivially
implementable by an integrator in any language. It requires distributing a
symmetric secret to every integrator, and that secret can both mint *and*
verify — so a leak from any integrator is a forge capability against their
tenant.

**EdDSA with JWKS** means the integrator holds a private key we never see and
publishes a public JWKS we fetch. No secret distribution, key rotation is the
integrator's business, and self-serve onboarding becomes possible without a
secret-exchange step.

**Recommendation: EdDSA + JWKS, with HS256 retained as an explicitly-configured
per-tenant option.** The ledger already leans this way above ~10 integrators,
and the asymmetry is that adding EdDSA later means re-onboarding everyone,
while adding HS256 later is a config flag. Build the harder-to-retrofit one.

Requires a JWKS fetch with caching and a bounded refresh — which is outbound
HTTP on the auth path, and needs a timeout, a cache, and a documented failure
mode. Note it as real work rather than a library call.

---

## Work items

### 2.2 Drizzle schema and migrations

Tables: `tenants`, `calendars`, `events`, `recurrence_overrides`, `audit_log`
(populated in Phase 6), `ics_sources` (Phase 7), `feed_tokens` (Phase 5).

Every tenant-scoped table carries a non-null `tenant_id`. The timing columns
follow Phase 1's resolution of O5 — this is the migration that O5 blocks.

Migration files are reviewed as public API: the schema is visible to
integrators and to anyone self-hosting, so readability is a requirement rather
than a nicety.

### 2.3 Row-level security policies

- `ALTER TABLE … ENABLE ROW LEVEL SECURITY` **and `FORCE ROW LEVEL SECURITY`**
  on every tenant-scoped table. Without `FORCE`, the table owner bypasses
  policies — and the migration role is usually the owner, which makes the
  protection silently absent in exactly the setup most people run.
- The application connects as a role that is **not** the table owner and is
  **not** superuser. Document this; it is the single easiest way to deploy
  this system with RLS quietly disabled.
- Policies read a session variable (e.g. `current_setting('gnomon.tenant_id', true)`).
- The variable is set with `set_config(..., true)` — transaction-local, so a
  pooled connection cannot leak tenant context into the next checkout. This
  interacts with connection pooling and must be tested under a pool, not a
  single connection.

### 2.4 JWT verification middleware

Hono middleware using `jose`. Verifies signature, `aud`, `exp`, and issuer;
extracts `tid`, `cal`, `scp`, `sub` per ADR-0004; sets the Postgres session
variable for the request's transaction.

Must reject, with tests: expired tokens, `alg: none`, algorithm confusion
(HS256 token verified against an EdDSA public key), a `tid` the issuer is not
authorised for, and tokens with no `exp`.

### 2.5 Token-minting reference implementations

Node plus one other language — Python or Go — since integrators will not all
be on Node. Copy-pasteable, dependency-minimal, correct about TTL and clock
skew. These are documentation that happens to compile, and they are the first
thing an integrator reads.

### 2.6 Test infrastructure

Testcontainers with a real Postgres. RLS cannot be tested against a mock, and
testing it against a superuser connection tests nothing.

---

## Exit criteria

- [ ] O2 resolved and recorded as an ADR
- [ ] An RLS-enforced integration test proves tenant A cannot read tenant B's
      events **even with a forged calendar ID in the token**
- [ ] The same test passes when run as the application role, and is
      demonstrated to *fail* if `FORCE ROW LEVEL SECURITY` is dropped
- [ ] Tenant context does not leak across pooled connection checkouts, proven
      under a pool
- [ ] Algorithm-confusion and `alg: none` attacks are rejected, with tests
- [ ] Migrations apply cleanly from empty, and are readable

---

## Verification

```bash
pnpm db:up
pnpm --filter @gnomon/server test          # testcontainers; needs Docker
```

> Docker is not currently installed on the development machine (see Phase 0.4).
> That must be fixed before this phase can be verified at all.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| RLS silently inactive because the app connects as owner or superuser | **High** | Assert the negative: a test that removes `FORCE` must turn the isolation test red. |
| Session variable leaks across pooled connections | **High** | Transaction-local `set_config`; test under a pool. |
| JWKS endpoint down or slow ⇒ auth path hangs | Medium | Bounded timeout, cached keys, documented failure mode. |
| Integrator mints long-TTL tokens because our example did | Medium | Reference implementations model a ~5 minute TTL and say why. |

---

## Out of scope

- Any HTTP endpoint that returns calendar data (Phase 3)
- Token revocation lists — TTL-based revocation is the accepted trade in ADR-0004
- Admin UI, tenant self-registration, billing
