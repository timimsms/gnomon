# ADR-0003: The renderer sits behind an adapter

**Status:** Accepted
**Date:** 2026-08-09
**Relates to:** L3

## Context

Gnomon does not draw calendars. Drawing a calendar grid — month cells,
overlapping event layout, drag targets, `dayMaxEvents` overflow popovers — is
a solved problem with several mature MIT implementations. Re-solving it would
consume most of the build budget and produce something worse.

So we adopt a renderer. The question is which, and how tightly.

The market moved twice against consumers in the eight months before this
decision:

- **Schedule-X v4** (January 2026) moved `@schedule-x/drag-and-drop` and
  `@schedule-x/resize` from the MIT core to `@sx-premium/*`, as part of what
  the maintainer described as a clearer free/premium split.
- **FullCalendar v7** (June 2026) changed the copyleft path for Premium
  packages from GPLv3 to AGPLv3, explicitly to close the SaaS loophole that
  for-profit companies had been using.

Neither change was wrong of those maintainers. Both would have been expensive
for us had we been depending on the affected features.

A third data point: **Toast UI Calendar**, which appears near the top of most
"best open-source calendar" listicles, last published four years ago.

The pattern is that renderer licensing and maintenance are *outside our
control and prone to sudden change*, while the surface we need from a renderer
is small and stable.

## Decision

All renderer interaction goes through a `RendererAdapter` interface owned by
`@gnomon/embed`. No Gnomon code imports a renderer package directly.

The interface is deliberately narrow — roughly:

```
mount(host, options)   destroy()
setEvents(occurrences) setView(view)
setDate(date)          setTheme(tokens)
on(event, handler)     refresh()
```

Launch implementation is **`@event-calendar`** (vkurko): MIT, zero-dependency
standalone bundle, resource and timeline views included in the free tier,
actively maintained through 2026 (Svelte 5 rune rewrite), FullCalendar-
compatible option naming, and deployed on 70,000+ sites via Bookly. Critically,
it has *no premium tier at all* — there is nothing to be moved behind a paywall
later.

A **second adapter** targeting FullCalendar Standard (MIT) ships in Phase 4,
not "later."

## Consequences

- The adapter is a real cost: some renderer capabilities will be inexpensive
  to reach directly and awkward to reach through the interface. Accepted.
- Building the second adapter in Phase 4 costs several days that produce no
  user-visible feature. This is the point. An adapter with one implementation
  is a guess; an adapter with two is a seam. If we defer it, we will discover
  at the worst possible moment that the interface leaked renderer-specific
  assumptions.
- If the interface cannot express something a renderer offers, the answer is
  usually to drop the feature rather than widen the interface. Widening it is
  an ADR-level change.
- Occurrence expansion stays server-side in `@gnomon/core` regardless of
  renderer, so a renderer swap never touches recurrence correctness.

## Alternatives considered

**Write our own renderer.** Full control, no license exposure, and permanently
the wrong use of the budget. Overlapping-event layout alone is weeks.

**Depend directly on FullCalendar Standard.** Most familiar to contributors,
largest ecosystem. Rejected because the Standard/Premium boundary is exactly
the boundary that moved in v7, and a contributor adding a resource view would
not necessarily notice they had pulled in an AGPL package. The license gate
(ADR-0002) catches this, but an architecture that doesn't rely on a CI check
to stay legal is better than one that does.
