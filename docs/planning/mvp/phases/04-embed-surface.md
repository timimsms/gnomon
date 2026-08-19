# Phase 4 — Embed surface

**Status:** 🚧 In progress — adapter seam and both implementations done
**Depends on:** Phase 3
**Blocks:** Phase 7 (accessibility, docs)
**Decisions in play:** L3 (renderer behind adapter), ADR-0003

---

## Objective

An integrator pastes one `<script>` tag into their portal and gets a themed,
working calendar — under a strict CSP, inside a hostile stylesheet, on a page
that may already have its own copy of anything.

Second-largest phase, and the first one with something to look at.

---

## Work items

### 4.1 `RendererAdapter` interface

Owned by `@gnomon/embed`. No Gnomon code imports a renderer package directly
(ADR-0003). Approximately:

```ts
interface RendererAdapter {
  mount(host: HTMLElement, options: RendererOptions): void;
  destroy(): void;
  setEvents(occurrences: readonly EventOccurrence[]): void;
  setView(view: 'month' | 'agenda'): void;
  setDate(date: string): void;
  setTheme(tokens: ThemeTokens): void;
  on(event: RendererEvent, handler: Handler): Unsubscribe;
  refresh(): void;
}
```

### 4.2 `@event-calendar` adapter

The launch implementation (L3).

### 4.3 Second adapter — FullCalendar Standard

**Built in this phase, not later.** ADR-0003 is explicit about why: an adapter
with one implementation is a guess, an adapter with two is a seam. Deferring it
means discovering that the interface leaked `@event-calendar` assumptions at
the moment we most need to switch.

It produces no user-visible feature and it is not optional.

**It earned its place immediately.** Four differences surfaced while writing
it, each of which the interface would otherwise have quietly inherited from
whichever renderer was written first:

| Difference | Consequence for the interface |
|---|---|
| One draws on construction; the other needs an explicit `render()` | `mount()` means "on screen" for both — the adapter absorbs it |
| One `destroy()` is synchronous and throws on a second call; the other returns a promise | The interface promises idempotent synchronous teardown; a `disconnectedCallback` has nowhere to put a rejected promise |
| One re-measures its container automatically; the other must be told | This is why `refresh()` exists. With one implementation it looked like a redundant method |
| `dateClick` is core in one, a separate plugin in the other | The event is promised either way; the adapter pays the cost |

Pinned to the **6.x** line: 7.x has a stable `core`, but its `daygrid` and
`list` plugins are still release candidates, and mixing majors is unsupported.
Standard packages only — Premium moved to AGPLv3 in v7 and must never appear.

### 4.4 Lit web component

Month and agenda/list views only. Shadow DOM by default — this is the primary
defence against host CSS.

### 4.5 Loader script

Hand-written, no dependencies, target <2KB gzipped. Reads `data-*` attributes,
fetches a token from the host's configured endpoint, injects the component.

This is the file every integrator pastes into their portal, and some of them
will read all of it before doing so. It must be auditable in one sitting. That
constraint outranks cleverness.

### 4.6 Theme token system

CSS custom properties (`--gnomon-*`) pierced into the Shadow DOM. No Tailwind —
we cannot assume the host has a build pipeline, and this is the file they
theme by hand.

### 4.7 iframe fallback

For hosts whose CSP forbids the inline/component path. Slower and less
integrated; it exists so the answer to "our CSP won't allow that" is never
"then you can't use this."

### 4.8 Playwright hostile-host suite

Against `apps/demo-portal`. Must include, as distinct scenarios:

- Strict CSP with no `unsafe-inline`
- A host CSS reset that targets `*`
- Host jQuery, and a host that has already loaded a *different* calendar library
- Two Gnomon embeds on one page, different calendars and timezones
- Host page in a different timezone from the calendar's
- Token expiry mid-session, exercising silent refresh
- Network failure on the token endpoint — must degrade visibly, not blankly

---

## Exit criteria

- [ ] Pasting one `<script>` tag into `demo-portal` yields a themed, working
      calendar under strict CSP
- [x] Both adapters pass the same adapter conformance suite — 25 tests, one
      suite, parameterised only by adapter name
- [x] Swapping the adapter requires **no change** outside the adapter module —
      the suite never imports a renderer and never branches on which is loaded,
      which is the demonstration
- [ ] Loader is under 2KB gzipped, with the measurement in CI
- [ ] Every hostile-host scenario in 4.8 is green
- [ ] Two embeds on one page do not interfere

---

## Verification

```bash
pnpm --filter @gnomon/embed test
pnpm --filter demo-portal test:e2e
```

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Adapter interface leaks `@event-calendar` assumptions | **High** | The second adapter (4.3) is the test of this, which is why it ships now. |
| Shadow DOM insufficient against determined host CSS | Medium | iframe fallback (4.7). |
| Loader grows past 2KB by increments | Medium | CI size budget, failing rather than warning. |
| Renderer's own a11y is poor and we inherit it | Medium | Assessed here; the accessibility pass in Phase 7 may constrain adapter choice. |

---

## Out of scope

- Week and day views — month and agenda only for v0.1
- Resource and timeline views (explicit non-goal)
- Drag-and-drop and resize — write path is Phase 6, and recurring events are
  never editable in v0.1 (L4)
- Framework wrappers (React, Vue) — a web component is the wrapper
