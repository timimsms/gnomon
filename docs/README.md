# Documentation

## If you are…

**…deciding whether to use Gnomon** — start with the
[project README](../README.md): what it is, what it deliberately is not, and
the [known limitations](../README.md#known-limitations-in-v01).

**…integrating it into a portal** — the
[token-minting cookbook](../examples/token-minting/README.md) is the whole
integration: one backend endpoint and one script tag. Both reference
implementations are zero-dependency and are exercised against the real
verifier in CI.

**…contributing** — [CONTRIBUTING.md](../CONTRIBUTING.md), particularly the
testing section. The habit of proving a test can fail has caught more bugs
here than any other practice.

**…wondering why something is the way it is** —
[the decision ledger](decisions/README.md). Every ADR records what was
rejected and why, which is the part that is expensive to reconstruct later.

**…picking up the work** — [the phase specifications](planning/mvp/phases/README.md).
Phases 0–6 are complete; [Phase 7](planning/mvp/phases/07-ics-in-polish.md) is
what remains.

---

## What lives where

| Path | Contents | Kept current? |
|---|---|---|
| [`decisions/`](decisions/README.md) | The ledger and eleven ADRs | Yes — a decision is changed by a superseding ADR, never by a quiet diff |
| [`planning/mvp/phases/`](planning/mvp/phases/README.md) | One spec per phase: work items, exit criteria, risks | Yes — updated as each phase closes, including what each one found |
| [`planning/mvp/GAMEPLAN.md`](planning/mvp/GAMEPLAN.md) | The original scoping document | **No.** Deliberately frozen as a record of the original reasoning, with a banner listing the four things it got wrong |

---

## The shape of the argument

Three decisions explain most of the codebase, and reading them in this order
makes the rest follow:

1. **[ADR-0004](decisions/0004-host-minted-tokens.md) — Gnomon has no user
   accounts.** The host portal already knows who its users are; we inherit
   that. This is what makes "free to embed" economically real, and it is why
   there is no login, no password reset, and no email anywhere in the project.

2. **[ADR-0005](decisions/0005-all-day-events-are-floating-dates.md) — all-day
   events are floating dates.** The only decision in the project that could
   not have been reversed later, because migrating between the two models
   requires exactly the information the losing model discarded.

3. **[ADR-0003](decisions/0003-renderer-adapter.md) — the renderer sits behind
   an adapter.** Two renderers moved features behind paywalls in the eight
   months before the project started. The adapter has two implementations
   precisely so that the seam is a fact rather than a hope.

---

## Things worth knowing that are not decisions

Findings from building it, each documented where it bit:

- Shadow DOM does not stop **inherited** CSS properties, so a host's
  `* { font-family: … !important }` reaches inside without ever crossing the
  boundary — see [Phase 4](planning/mvp/phases/04-embed-surface.md).
- A stylesheet in `document.head` does not apply inside a shadow root, so a
  renderer can emit perfectly correct markup and text with no layout at all —
  and every text-based assertion passes.
- Postgres renders `timestamp` with a **space**, not a `T`. Temporal accepts
  it, so three phases of code normalised it invisibly before an ICS feed
  finally serialised a stored value without expanding it first — see
  [Phase 5](planning/mvp/phases/05-ics-feed-out.md).
- `useDefineForClassFields` defaults to true at ES2022+, which silently
  overwrites the accessors Lit installs. The element renders once, empty, and
  never updates; typecheck and build are both perfectly happy.
