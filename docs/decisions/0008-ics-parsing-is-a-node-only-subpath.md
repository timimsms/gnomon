# ADR-0008: ICS interop lives in a Node-only subpath export

**Status:** Accepted
**Date:** 2026-08-10
**Relates to:** L9, Phase 1 work items 1.7–1.8

## Context

L9 requires `@gnomon/core` to be I/O-free, so that expansion runs identically
on the server and in the browser and integrators can reuse it client-side.

Phase 1 also requires ICS parsing. The stack decision names `node-ical`
(Apache-2.0), and inspecting version 0.27.1 shows:

- `node-ical.js`, the package entry, imports `node:fs` for `parseFile`
- `ical.js`, the parser proper, imports `randomUUID` from `node:crypto`
- the `exports` map exposes only `.`, so there is no way to reach the parser
  without also pulling the `fs` import

Importing `node-ical` anywhere reachable from `@gnomon/core`'s main entry
would therefore drag `node:fs` into every browser bundle, breaking L9.

Its dependency footprint is otherwise excellent — only `rrule-temporal` and
`temporal-polyfill`, both of which we already depend on.

## Decision

**`@gnomon/core`'s main entry stays pure. ICS interop moves to a
`@gnomon/core/ics` subpath export, documented as Node-only.**

```
@gnomon/core        types, expansion, window guards  — pure, runs anywhere
@gnomon/core/ics    parse + serialize                — Node only
```

A subpath is not an exception to L9. Importing `@gnomon/core` does not pull
`@gnomon/core/ics`, so the browser bundle is unaffected; the constraint holds
exactly where it was meant to.

**Serialisation is hand-rolled and pure** even though it lives in the same
subpath. It is grouped with parsing because "ICS interop" is one coherent
surface and splitting a serialiser away from its parser to chase a purity
boundary neither of them needs would be worse. If a browser use case for
serialisation ever appears, it moves out; nothing prevents that.

**`node-ical` is used strictly as a text parser.** It depends on
`rrule-temporal` and will happily expand recurrences itself — and would
inherit all three of the defects `expand.ts` corrects. We take the raw
`RRULE`, `EXDATE`, and `RECURRENCE-ID` values and expand them ourselves.

## Consequences

- Integrators can reuse expansion in the browser, which was the point of L9.
  They cannot parse ICS there. No known use case needs it: ICS arrives from
  feeds the server fetches.
- The Node-only constraint must be stated in the package documentation, or
  someone will import the subpath into a bundle and get a confusing
  build error rather than a clear one.
- We own the correctness of recurrence expansion end to end, rather than
  splitting it between our engine and `node-ical`'s. Given that we correct
  three defects in the shared underlying library, having two expansion paths
  would have been a latent inconsistency.
- If `node-ical` ever ships a browser-safe subpath, this ADR can be revisited
  cheaply — the boundary is one file.

## Alternatives considered

**Move ICS parsing to `apps/server`.** Keeps `@gnomon/core` unambiguously
pure. Rejected because the round-trip conformance test — the thing that makes
the serialiser trustworthy — would then straddle two packages, and the
serialiser has no reason to live in the server.

**Write our own RFC 5545 parser.** Removes the dependency entirely and would
make the whole of core pure. Rejected as scope: unfolding, parameter parsing,
value-type coercion, and `VTIMEZONE` handling are a phase of work on their
own, and `node-ical` is permissively licensed and maintained. We already
hand-roll *serialisation*, where the output surface is narrow and fully ours;
parsing has to accept whatever the world sends, which is a much larger
surface.

**Bundle-alias `node:fs` to a stub.** Makes the browser build succeed by
lying about what the code does. Rejected.
