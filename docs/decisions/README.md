# Decision Ledger

Decisions are **locked** or **open**. Locked decisions may be overturned, but
only by superseding ADR — not by a quiet diff. Open decisions name the phase
they block, so nobody discovers them at merge time.

Last reviewed: 2026-08-10

---

## Locked

| # | Decision | Rationale | Consequence |
|---|---|---|---|
| L1 | MIT license | Adoption is the point. AGPL deters the integrators we're courting. | See [ADR-0001](0001-mit-license.md). We cannot prevent SaaS repackaging. Accepted. |
| L2 | Permissive dependencies only, enforced in CI | One AGPL dep silently relicenses everything. | See [ADR-0002](0002-permissive-dependencies-only.md). `scripts/check-licenses.mjs` runs before tests. Allowlist changes require an ADR. |
| L3 | `@event-calendar` (vkurko) as launch renderer, behind an adapter | MIT, zero-dep bundle, resource + timeline free, actively maintained. No premium plugins to accidentally depend on. | See [ADR-0003](0003-renderer-adapter.md). A second adapter ships in Phase 4 as proof of the seam. |
| L4 | Read-mostly v0.1 — recurrence is stored and expanded, never edited | "This / this and following / all" is where calendar projects die. | Recurring events are read-only until v0.2. Documented as a limitation, not a bug. |
| L5 | No user accounts. Host portal mints a scoped, short-lived JWT. | We inherit their identity system. No login, password reset, or email delivery. | See [ADR-0004](0004-host-minted-tokens.md). Integrators must run backend code; pure-static sites are unsupported. |
| L6 | Temporal, with `temporal-polyfill` on the client | Stage 4 / ES2026. Native in Chrome 144+, Firefox 139+, Edge 144+. | ⚠️ **The server half of this is factually wrong** — Node 26.3.0 exposes no `Temporal`. See O7. |
| L7 | Shared instance, row-level tenancy via Postgres RLS | Tenant comes from a JWT claim, injected as a session variable. | Every table carries `tenant_id`. Single-tenant deploys remain possible but aren't the default. |
| L8 | Single container + Postgres. No Redis, no broker. | The infra floor *is* the competitive moat against per-seat commercial options. | Jobs run on `pg-boss`. If we ever need a broker, the free-to-embed economics need re-examining first. |
| L9 | TypeScript end-to-end, pnpm monorepo | Lowers the OSS contribution barrier; recurrence logic is shared between server expansion and client preview. | `packages/core` stays I/O-free so it runs in both environments unchanged. |
| L10 | ICS feed out is a Phase 5 deliverable, not a stretch goal | Cheapest extensibility hook available. Buys Google/Apple/Outlook subscription with zero OAuth work. | Feed URLs carry opaque revocable tokens and no PII. |
| L11 | v0.1 stays generic — no design partner | Real portal constraints would sharpen the model but bias it toward one vertical. | We will be wrong about some field somewhere. Cheaper to be wrong generically than to bake in a vertical. |

---

## Open

| # | Question | Blocks | Notes |
|---|---|---|---|
| O2 | JWT signing: HS256 per-tenant shared secret vs. EdDSA + JWKS | Phase 2 | HS256 ships faster. EdDSA avoids secret distribution and scales to self-serve onboarding. Lean EdDSA if we expect more than ~10 integrators. |
| O6 | Governance model (BDFL vs. contributor ladder) | Phase 7 | Only matters when outside contributors arrive. |

### Closed

- **O1 (name)** — resolved: **Gnomon**. The shadow-casting pin on a sundial: the part that turns time into something readable off a surface. npm scope `@gnomon/*`.
- **O3 (design partner)** — resolved: none. v0.1 stays generic (see L11).
- **O4 (materialise vs. expand on read)** — resolved: expand on read, bounded by both a window cap and an occurrence-count cap. See [ADR-0007](0007-expand-on-read.md).
- **O5 (all-day semantics)** — resolved: floating dates, as a discriminated union with exclusive `endDate`. Zone-anchored indexing is derived, not stored as truth. See [ADR-0005](0005-all-day-events-are-floating-dates.md).
- **O7 (server Temporal)** — resolved: `temporal-polyfill` on both server and client, behind a single re-export module. Amends L6, whose "Node 26+ is native" premise was verified false. See [ADR-0006](0006-temporal-acquisition.md).
