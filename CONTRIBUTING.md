# Contributing

## Setup

```bash
pnpm install
pnpm test
```

## Before you open a PR

CI runs three gates, in this order:

1. `pnpm lint:licenses` — dependency license compliance
2. `pnpm typecheck`
3. `pnpm test`

The license gate runs first on purpose. A copyleft dependency is a licensing
incident, not a test failure.

## Adding a dependency

Gnomon is MIT and must stay installable without legal review. If your
dependency is not under a permissive license already in the allowlist in
`scripts/check-licenses.mjs`, the build will fail — and the fix is not to edit
the allowlist. Open an ADR first.

Prefer no dependency. `packages/core` in particular should stay close to
dependency-free so it runs unchanged in Node and the browser.

## Decisions

Locked decisions live in `docs/decisions/README.md`. They can be overturned,
but by a superseding ADR — not by a quiet diff. If a PR contradicts a locked
decision, say so in the description and expect the ADR conversation first.

Open decisions are listed with the phase they block. If you hit one, don't
guess: resolve it in the ledger.

## Style

- Comments explain *why*, not *what*. If a line needs a comment to say what it
  does, rewrite the line.
- Recurrence and timezone code gets a fixture, always. "It looked right in the
  browser" is not evidence.
