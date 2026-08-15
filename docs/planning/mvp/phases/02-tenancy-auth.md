# Phase 2 — Tenancy and auth

**Status:** 🚧 In progress — O2 closed; schema, token verification and reference implementations done; RLS blocked on Docker
**Depends on:** Phase 1 (the schema encodes Phase 1's timing model)
**Blocks:** Phases 3–7
**Decisions in play:** L5 (no accounts), L7 (RLS tenancy), L8 (Postgres only), ADR-0009 (EdDSA)
**Must close:** none — O2 closed before the phase began

---

## Objective

Tenancy is enforced by the database rather than by remembering to write a
`WHERE` clause, and identity arrives from the host portal as a short-lived
signed token that we verify but never issue.

This is a security boundary. It is built before there is an API to protect,
because boundaries retrofitted around existing code leak at exactly the places
that code already exists.

---

## 2.1 O2 — closed

Resolved as [ADR-0009](../../../decisions/0009-eddsa-with-registered-public-keys.md):
**EdDSA (Ed25519), verified against public keys registered at onboarding.
JWKS deferred.**

The question as originally framed bundled two decisions with very different
reversibility. Symmetric-vs-asymmetric is a re-onboarding event for the whole
install base if changed later; how the public key reaches us is additive — a
column, a fetcher, a per-tenant flag. Only the first needed deciding now, so
JWKS is deferred rather than rejected, and this phase does not take on
tenant-controlled outbound HTTP inside the authentication path.

The two implementation details that carry the security weight:

- **Derive the tenant from the key, never from the claim.** A `kid` maps to
  exactly one tenant; if `tid` disagrees, reject. A valid signature proves who
  signed the token, never what they are entitled to claim.
- **Accept exactly one algorithm.** The verifier takes an explicit allowlist
  of one and never reads `alg` to choose a key type. Supporting a second
  algorithm is what makes confusion attacks possible.

Verified: Node 26.3.0 WebCrypto supports Ed25519 natively (`kty=OKP`),
`jose` 6.2.8 is MIT.

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

`drizzle-kit generate` emits migration SQL **without a database connection**,
so the schema is written and reviewed offline; only applying it needs Postgres.

Two things beyond the table list are worth naming:

**Composite foreign keys.** Children reference their parent by
`(calendar_id, tenant_id)`, not `calendar_id` alone. The tenant column being
part of the key makes a cross-tenant reference impossible at the storage
layer, rather than merely discouraged by a policy someone might misconfigure —
defence that survives RLS being switched off.

**The timing union is enforced by CHECK constraints,** not by convention.
`timing_kind = 'allDay'` alongside a populated `start_local` is otherwise a
representable state with no meaning, and every reader has to decide what to do
about it.

**`events.search_span`** is a `tstzrange` GiST index used as a coarse
pre-filter, with exact boundaries always applied afterwards by
`@gnomon/core`. Its only invariant is that it is never *narrower* than
reality: a too-wide span costs one wasted expansion, a too-narrow one silently
drops events and nothing downstream can detect it. All-day spans are padded by
±14 hours — the widest IANA offset — so they hold for **any** rendering
timezone and, critically, do not depend on `calendars.time_zone`. Anchoring
them to the calendar zone would mean correcting a misconfigured timezone
silently invalidated every stored span, which is the coupling ADR-0005
rejected zone-anchored storage to avoid.

A near-miss worth recording: the composite foreign keys were first written as
raw `sql` template literals in Drizzle's table-extras array, which Drizzle
**accepts and silently ignores**. It reported `events ... 0 fks` and emitted a
migration with no foreign key on events at all; typecheck passed. Nothing
would have caught it until cross-tenant rows appeared. `test/schema.test.ts`
now asserts against the emitted SQL, and that test was confirmed to fail when
the mistake is reintroduced.

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

Hono middleware using `jose`. Verifies signature, `aud`, `exp`, and the `kid`
key lookup; extracts `tid`, `cal`, `scp`, `sub` per ADR-0004; sets the
Postgres session variable for the request's transaction.

Must reject, with tests: expired tokens, `alg: none`, an HS256 token whose
payload is verified against a registered Ed25519 key, a token signed by a
valid key for tenant A but claiming `tid: B`, an unknown `kid`, a missing
`exp`, and a token whose lifetime exceeds the configured maximum.

Crypto verification is independent of Postgres, so this is buildable and
testable without Docker.

### 2.4a Verified, not assumed

Both security claims were checked by breaking them and watching a specific
test go red — the same discipline the phase 1 corpus used.

| Control disabled | Result |
|---|---|
| Tenant cross-check removed, `tid` claim trusted | Cross-tenant test goes red — a validly-signed token asserting another tenant is accepted |
| Header `alg` pre-check removed, allowlist left at `['EdDSA']` | All tests still pass — the allowlist alone stops the attack |
| Allowlist widened to `['EdDSA', 'HS256']` | **The HS256 confusion forgery verifies.** An attacker holding only the public key we publish can mint a token for that tenant |

The third row is the one that matters: the single-entry allowlist is the
actual control, and the header check is defence in depth. This is why
ADR-0009 treats "accept one algorithm" as a security property rather than a
simplification.

### 2.5 Token-minting reference implementations

Node plus one other language — Python or Go — since integrators will not all
be on Node. Copy-pasteable, dependency-minimal, correct about TTL and clock
skew. These are documentation that happens to compile, and they are the first
thing an integrator reads.

**Shipped: Node and Go, both zero-dependency.** Node's `crypto` and Go's
`crypto/ed25519` are built in, and a JWT is three base64url segments joined by
dots — so neither example needs a JWT library, and an integrator can read the
whole file before trusting it. `go run mint.go` needs no `go.mod`.

Go was chosen over Python for a specific reason: `cryptography` was not
installed on the development machine, so a Python example could not have been
*run* against the verifier. Shipping two verified examples beats shipping
three where one is decorative — which is the liability this work item names.

Also ships `keygen.mjs`, since an integrator's first step is generating a key
pair, and it is the step where a private key most easily ends up somewhere it
should not.

Every example is exercised against the **real verifier** in
`apps/server/test/reference-implementations.test.ts`, which also asserts the
two implementations emit identical headers and claims — divergence means one
was edited and the other was not. A `toolchain coverage` test fails the build
if CI lacks Go, because a skipped example is an unverified example.

### 2.6 Test infrastructure

Testcontainers with a real Postgres. RLS cannot be tested against a mock, and
testing it against a superuser connection tests nothing.

---

## Exit criteria

- [x] O2 resolved and recorded as an ADR ([ADR-0009](../../../decisions/0009-eddsa-with-registered-public-keys.md))
- [ ] An RLS-enforced integration test proves tenant A cannot read tenant B's
      events **even with a forged calendar ID in the token**
- [ ] The same test passes when run as the application role, and is
      demonstrated to *fail* if `FORCE ROW LEVEL SECURITY` is dropped
- [ ] Tenant context does not leak across pooled connection checkouts, proven
      under a pool
- [x] Algorithm-confusion and `alg: none` attacks are rejected, with tests
- [x] A token signed by tenant A's key but claiming tenant B's `tid` is
      rejected — the tenant comes from the key, not the claim
- [x] Every token-minting reference implementation is exercised against the
      real verifier, and CI fails rather than skips if a toolchain is missing
- [ ] Migrations apply cleanly from empty (needs Docker), and are readable
- [x] Every tenant-scoped table carries a non-null `tenant_id`, asserted from
      the schema so a new table cannot quietly escape RLS
- [x] `search_span` is proven a conservative superset across the phase 1
      corpus, in the extreme rendering timezones (+14, −12, UTC)

---

## Verification

```bash
pnpm --filter @gnomon/server test          # token verification; no Docker
pnpm db:up
pnpm --filter @gnomon/server test:db       # RLS via testcontainers; needs Docker
```

The phase splits cleanly along the Docker boundary, so it is worth doing in
that order:

| Work item | Needs Docker |
|---|---|
| 2.4 token verification, 2.5 reference implementations | no — pure crypto |
| 2.2 schema definition | no — writing it |
| 2.2 migration application, 2.3 RLS, 2.6 | **yes** |

> Docker is not currently installed on the development machine (see Phase 0.4).
> Everything in the first two rows can proceed without it; nothing in the third
> can be verified at all until it is installed, and an RLS policy that has
> never been executed is a comment.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| RLS silently inactive because the app connects as owner or superuser | **High** | Assert the negative: a test that removes `FORCE` must turn the isolation test red. |
| Session variable leaks across pooled connections | **High** | Transaction-local `set_config`; test under a pool. |
| Tenant taken from the `tid` claim rather than from the key | **High** | A valid signature proves authorship, not entitlement. Dedicated test (ADR-0009). |
| Key rotation is manual, so it does not happen | Medium | Multiple concurrent keys per tenant make it non-disruptive. JWKS remains the additive fix if this bites. |
| Integrator mints long-TTL tokens because our example did | Medium | Reference implementations model a ~5 minute TTL and say why. |

---

## Out of scope

- Any HTTP endpoint that returns calendar data (Phase 3)
- Token revocation lists — TTL-based revocation is the accepted trade in ADR-0004
- Admin UI, tenant self-registration, billing
