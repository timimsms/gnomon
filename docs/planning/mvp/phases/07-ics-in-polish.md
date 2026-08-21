# Phase 7 — ICS ingest and polish

**Status:** ⬜ Next — everything before it is complete
**Depends on:** all previous phases
**Decisions in play:** L8 (`pg-boss`, no broker)
**Must close:** **O6** (governance model)

---

## Objective

Gnomon can subscribe to external calendars as well as publish them, the web
component is usable without a mouse or a monitor, an integrator can get from
zero to an embedded calendar by following documentation alone — and v0.1.0 is
tagged.

Three loosely-related workstreams sharing a phase. They can proceed in
parallel; the accessibility pass is the one that most often gets cut, so it is
listed first.

---

## Where to start

Suggested order, on the reasoning that the riskiest item should not be last
and the two blocked items should be unblocked early:

1. **7.4 — resolve O6 (governance).** The only open decision left, and it is
   cheap. Tagging v0.1.0 is exactly what invites the outside contributors it
   governs, so deciding it after the first outside PR is deciding it under
   pressure.
2. **7.2 — ICS ingest, SSRF first.** The highest-severity item remaining in
   the whole plan. Write the address validation and its tests *before* the
   fetching and reconciliation, because it is much harder to retrofit a
   security control around code that already works without it.
3. **7.1 — accessibility.** Most likely to be cut under time pressure and
   least likely to be added afterwards.
4. **7.3 / 7.5 — docs and release.** Last, because they describe the rest.

### Two items are blocked on things code cannot do

Both are exit criteria and neither can be closed by writing more:

- **The three-client feed check** (Phase 5). Google, Apple and Outlook
  disagree in practice and none of the disagreements surface in a unit test.
  `pnpm --filter @gnomon/server db:bootstrap` prints a `webcal://` URL.
  **Google fetches server-side**, so it needs a publicly reachable host — a
  tunnel or a deployed instance, not `localhost`.
- **`docker compose up` in under two minutes on a cold machine** (7.5).
  Docker is not installed on the current development machine. Everything else
  now runs against any Postgres ([ADR-0010](../../../decisions/0010-test-database-provisioning.md)),
  so this is the last thing that genuinely needs Docker.

### What the phase inherits

Worth knowing before starting, because each shortens a work item:

- **`pg-boss` has not been introduced yet.** L8 assumes it for jobs, and 7.2's
  polling is the first thing that needs a scheduler. It is a new dependency
  and therefore a licence-gate event.
- **The ICS parser already exists** and round-trips the phase 1 corpus
  ([ADR-0008](../../../decisions/0008-ics-parsing-is-a-node-only-subpath.md)).
  7.2 is fetching, scheduling and reconciliation — not parsing.
- **`ics_sources` is already in the schema** with `etag`, `last_modified`,
  `last_error` and `consecutive_failures` columns, under RLS.
- **Reconciliation matches on `uid`**, which is why phase 1 kept `uid`
  distinct from `id`.
- **Ingested events must be read-only to the phase 6 write path**, or the next
  poll silently overwrites a user's edit. That refusal wants the same specific
  treatment recurrence editing got, for the same reason.

---

## Work items

### 7.1 Accessibility pass

The web component must be usable with a keyboard and a screen reader:

- Keyboard navigation through the month grid (arrow keys between days,
  `PageUp`/`PageDown` between months)
- ARIA grid semantics on the month view
- Screen reader announcements on view and date change — a silent view change
  is indistinguishable from a broken one
- Visible focus indicators that survive host CSS
- Colour contrast in the default theme tokens, and documentation of the
  contrast requirement for integrators overriding them
- Respect `prefers-reduced-motion`

Much of this is inherited from the renderer and may be outside our control. Where
the renderer's semantics are inadequate, the finding goes in an ADR — it is
evidence about adapter choice, which is precisely what ADR-0003 anticipated.

### 7.2 ICS source registration and polling

- Register an external ICS URL as a source for a calendar
- `pg-boss` scheduled polling — no broker, no Redis (L8)
- **ETag-conditional fetch.** Unconditional polling of external feeds is rude
  and expensive; store the `ETag`/`Last-Modified` and send conditional requests.
- Reconciliation: added, changed, and removed events, matched by ICS `UID`
  (which is why Phase 1.4 keeps `uid` distinct from `id`)
- Failure handling: exponential backoff, a surfaced last-error and last-success
  per source, and a bounded retry that gives up loudly rather than retrying
  forever

**Fetching a URL supplied by a tenant is an SSRF sink.** Block private address
ranges, link-local, and loopback; validate after DNS resolution rather than
before, or the check is bypassed by a hostname that resolves inward; cap
response size and redirect count. This is the highest-severity item in the
phase and it is not obvious from the feature description.

Ingested events are read-only with respect to the Phase 6 write path — a
mutation would be overwritten by the next poll. Reject it explicitly.

### 7.3 Documentation site and quickstart

- Integration quickstart: `<script>` tag to working calendar
- Token-minting cookbook, extending the Phase 2.5 reference implementations
- Theming reference for the `--gnomon-*` tokens
- Self-hosting guide
- **A documented limitations page**, stating plainly that recurring events are
  read-only in v0.1 (L4), that a backend is required to mint tokens (ADR-0004),
  and what the feed window bounds are. Every one of these will otherwise arrive
  as a bug report.

### 7.4 O6 — governance model

Only matters at the point outside contributors arrive, which is what tagging
v0.1.0 invites. Resolve before the tag, not after the first PR.

### 7.5 Release

Version, changelog, npm publish for `@gnomon/core`, `@gnomon/embed`,
`@gnomon/loader`, a published Docker image, and a tagged `v0.1.0`.

Verify the adoption claim directly: `docker compose up` must produce a working
calendar with a seeded demo tenant in under two minutes, timed on a machine
that has never run it. If that fails, the OSS adoption story fails at the first
step and the tag should wait.

---

## Exit criteria

- [ ] Month view is fully keyboard-navigable; view changes are announced
- [ ] Default theme meets WCAG AA contrast
- [ ] An external ICS feed polls, reconciles adds/changes/removes by `UID`, and
      backs off correctly on failure
- [ ] SSRF protections are tested against DNS-rebinding-shaped inputs, not only
      literal private IPs
- [ ] A new integrator reaches a working embedded calendar from documentation
      alone, without reading source
- [ ] `docker compose up` → working seeded calendar in under two minutes on a
      cold machine
- [ ] O6 resolved and recorded
- [ ] `v0.1.0` tagged and published

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| SSRF via tenant-supplied ICS URLs | **High** | Post-resolution address validation, size and redirect caps, tested. |
| Renderer a11y is inadequate and cannot be patched from outside | Medium | Assessed in Phase 4; ADR if it forces an adapter decision. |
| Polling load grows with source count | Medium | Conditional fetch, backoff, per-tenant source caps. |
| Docs drift from the API immediately after tagging | Medium | Quickstart examples run in CI; OpenAPI is generated, not written. |

---

## Out of scope

- Two-way sync — ingest is one-directional; L4 and the non-goals both hold
- OAuth to Google/Microsoft (explicit non-goal)
- i18n beyond `Intl` date formatting (explicit non-goal)
- Anything on the v0.2 list: recurrence editing, week/day views, availability
