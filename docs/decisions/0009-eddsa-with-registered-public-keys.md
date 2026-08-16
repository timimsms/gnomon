# ADR-0009: Tokens are EdDSA-signed, verified against registered public keys

**Status:** Accepted
**Date:** 2026-08-14
**Relates to:** O2 (closed), L5, L7, ADR-0004
**Blocks:** Phase 2

## Context

ADR-0004 established that Gnomon has no accounts: the host portal's backend
mints a short-lived JWT and we verify it. O2 asked how.

The ledger framed this as "HS256 per-tenant shared secret vs. EdDSA + JWKS",
with a lean toward EdDSA above roughly ten integrators. That framing bundles
two decisions that have very different costs to reverse:

1. **Symmetric or asymmetric.** Changing this later means every integrator
   regenerates credentials and redeploys their minting code. It is a
   re-onboarding event for the entire install base.
2. **How the public key reaches us** — registered at onboarding, or fetched
   from a JWKS endpoint. Changing this later is additive: a column, a fetcher,
   and a per-tenant flag. Nobody re-onboards.

Only the first is expensive to get wrong, so only the first needs deciding
now.

The symmetric option is genuinely attractive on effort. It is also the one
where **our database becomes a forgery capability**: with HS256 the same
secret both mints and verifies, so a read of our tenants table yields the
ability to issue a valid token for every tenant we serve. For a project whose
pitch is "embed this in your resident portal," that is the wrong shape of
blast radius, and no amount of encryption-at-rest changes what the secret
*is*.

Verified on the toolchain we actually have, since L6's runtime assumption did
not survive contact:

```
Node 26.3.0 WebCrypto:  Ed25519 → OK, kty=OKP crv=Ed25519
jose 6.2.8, MIT
```

Ed25519 signing is also in the standard library or a first-party package for
Python, Go, Ruby, PHP, and .NET, so the reference implementations in phase 2.5
do not need an exotic dependency in any language an integrator is likely to
use.

## Decision

**Tokens are signed with EdDSA (Ed25519). Integrators register a public key
with us at onboarding. We store only public keys. JWKS is deferred.**

- The JWT header carries `kid`. We look the key up by `kid` and use it to
  select the verifying key.
- **The tenant is derived from the key, not taken from the claim.** A `kid`
  maps to exactly one tenant. If the token's `tid` claim disagrees with the
  tenant that owns the verifying key, the token is rejected. Trusting `tid`
  because the signature was valid would let a legitimate tenant A token assert
  `tid: B` — the signature proves who signed it, never what they are entitled
  to claim.
- **Only EdDSA is accepted.** The verifier is configured with an explicit
  algorithm allowlist of exactly one entry, and never selects an algorithm
  from the token header. Supporting a second algorithm is what makes
  algorithm-confusion attacks possible; declining to support one removes the
  class by construction rather than by careful coding.
- `alg: none` and any non-EdDSA `alg` are rejected before key lookup.
- `aud` must be `gnomon`; `exp` is required. A token whose lifetime exceeds a
  configured maximum is rejected even if unexpired, so an integrator who mints
  a ten-year token gets an error rather than a standing liability. Clock skew
  tolerance is small and explicit.
- A tenant may have **several active keys at once**, which is what makes
  rotation possible without downtime: register `kid` N+1, deploy the
  integrator's change, then retire N.

## Consequences

- We cannot forge a token for any tenant, and a full database compromise does
  not change that. This is the property being bought and it is worth the extra
  onboarding step.
- **Rotation is a manual, coordinated act** rather than an automatic one. This
  is the real cost. It is mitigated by supporting multiple concurrent keys per
  tenant, and it is the strongest argument for adding JWKS later.
- No outbound HTTP on the authentication path: no fetch timeout, no cache
  staleness policy, no availability coupling to the integrator's host, and no
  SSRF sink. A tenant-supplied JWKS URL would be the same class of hazard as
  phase 7.2's tenant-supplied ICS URL, and this defers that work rather than
  taking it on in a security-critical path.
- Onboarding is not fully self-serve: a public key has to be registered. It
  need not be a *secure* channel, which is the meaningful improvement over
  HS256 — a public key may be emailed, pasted, or committed without harm.
- Integrators must hold a private key. That is a real operational
  responsibility, and it is one they already have if they terminate TLS.
- **Phase 2.5's reference implementations become more valuable, not less.**
  Signing an Ed25519 JWT is a handful of lines in every target language, but
  it is a handful nobody wants to get wrong. They are the first thing an
  integrator reads.

## Alternatives considered

**HS256 with a per-tenant shared secret.** Fastest to ship, trivial in any
language, no key registration step. Rejected on blast radius: our database
would become a forgery capability against every tenant, and the secret needs a
secure distribution channel that a public key does not.

**EdDSA + JWKS now.** The eventual answer, and rejected only on sequencing.
It buys automatic rotation and fully self-serve onboarding at the cost of
tenant-controlled outbound HTTP on the authentication path, plus the SSRF
hardening that implies. Since adding it later is additive and re-onboards
nobody, there is no reason to take that on inside the phase that also
establishes the tenancy boundary. This ADR is what it will amend.

**Support both HS256 and EdDSA, per tenant.** The earlier lean. Rejected once
the algorithm-confusion argument was taken seriously: two accepted algorithms
means the verifier must map algorithm to key type correctly on every path
forever, and the failure mode is silent and total. One algorithm is not a
limitation here, it is the security property.

**ES256 (ECDSA P-256) instead of Ed25519.** Broader legacy support, and
notably worse to implement safely — ECDSA nonce reuse is catastrophic and has
sunk real systems. Ed25519 is deterministic and has no nonce to misuse. Node,
browsers, and every target language support it.
