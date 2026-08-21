import type { EventOccurrence } from '@gnomon/core';
import type { ThemeTokens } from './theme.js';

/**
 * The renderer seam (ADR-0003).
 *
 * Gnomon does not draw calendars. Drawing one -- month cells, overlapping
 * event layout, overflow popovers -- is solved, and re-solving it would
 * consume the build budget and produce something worse.
 *
 * But renderer licensing and maintenance are outside our control and prone to
 * sudden change: Schedule-X moved drag-and-drop behind a paywall in January
 * 2026, FullCalendar tightened Premium copyleft to AGPLv3 that June, and Toast
 * UI has not published in four years. The surface we actually need is small
 * and stable, so it goes behind an interface and nothing else imports a
 * renderer package.
 *
 * DESIGN RULE: if the interface cannot express something a renderer offers,
 * the answer is usually to drop the feature rather than widen the interface.
 * Widening it is an ADR-level change, because every widening is a place the
 * next renderer may not be able to follow.
 */

export type ViewName = 'month' | 'agenda';

export interface RendererEvents {
  /** A user activated an occurrence. */
  occurrenceClick: { occurrence: EventOccurrence };
  /** A user activated empty space on a date. `date` is an ISO calendar date. */
  dateClick: { date: string };
  /** The visible range changed, by navigation or by a view switch. */
  rangeChange: { from: string; to: string; view: ViewName };
}

export type RendererEventName = keyof RendererEvents;
export type Unsubscribe = () => void;

export interface MountOptions {
  view: ViewName;
  /** ISO calendar date the view opens on. */
  date: string;
  /**
   * The zone occurrences are RENDERED in. Not the zone a recurrence is
   * anchored to -- that lives in the occurrence and was already resolved
   * server-side.
   */
  timeZone: string;
  /** BCP-47 tag for date formatting, via `Intl`. */
  locale?: string;
  theme?: ThemeTokens;
}

/**
 * Roughly eight methods, and deliberately no more.
 *
 * Everything here is something the Lit component genuinely needs. Nothing
 * here exposes a renderer-specific concept -- no plugin registration, no
 * renderer option bags, no escape hatch returning the underlying instance.
 * An escape hatch would be used, and once used the seam is decorative.
 */
export interface RendererAdapter {
  mount(host: HTMLElement, options: MountOptions): void;
  destroy(): void;

  setEvents(occurrences: readonly EventOccurrence[]): void;
  setView(view: ViewName): void;
  setDate(date: string): void;
  setTheme(tokens: ThemeTokens): void;

  on<E extends RendererEventName>(
    event: E,
    handler: (payload: RendererEvents[E]) => void,
  ): Unsubscribe;

  /** Re-lay-out after the host resized or revealed the element. */
  refresh(): void;
}

/** Identifies an implementation, for diagnostics and for the conformance suite. */
export interface RendererAdapterFactory {
  readonly name: string;
  create(): RendererAdapter;
}

/**
 * Emitter shared by implementations.
 *
 * Handlers are copied before dispatch so that a handler unsubscribing itself
 * -- which a "open a dialog, then detach" flow does routinely -- cannot make
 * the iteration skip its neighbour.
 */
export class EventBus {
  readonly #handlers = new Map<string, Set<(payload: never) => void>>();

  on<E extends RendererEventName>(
    event: E,
    handler: (payload: RendererEvents[E]) => void,
  ): Unsubscribe {
    const set = this.#handlers.get(event) ?? new Set();
    set.add(handler as (payload: never) => void);
    this.#handlers.set(event, set);
    return () => {
      set.delete(handler as (payload: never) => void);
    };
  }

  emit<E extends RendererEventName>(event: E, payload: RendererEvents[E]): void {
    for (const handler of [...(this.#handlers.get(event) ?? [])]) {
      (handler as (value: RendererEvents[E]) => void)(payload);
    }
  }

  clear(): void {
    this.#handlers.clear();
  }
}

/**
 * Occurrence timing, flattened for renderers.
 *
 * Every renderer we have looked at wants a start, an end, and an all-day
 * flag -- which is exactly the boolean shape ADR-0005 rejected for STORAGE.
 * That rejection stands: the flattening happens here, at the last possible
 * moment, and the lossy form never travels back inward.
 *
 * All-day events keep their exclusive end, because both renderers follow the
 * same RFC 5545 convention we do.
 */
export function toRendererTiming(occurrence: EventOccurrence): {
  start: string;
  end: string;
  allDay: boolean;
} {
  return occurrence.timing.kind === 'allDay'
    ? { start: occurrence.timing.startDate, end: occurrence.timing.endDate, allDay: true }
    : { start: occurrence.timing.start, end: occurrence.timing.end, allDay: false };
}

/**
 * Puts a renderer's stylesheet where the renderer actually rendered.
 *
 * THIS IS NOT OPTIONAL POLISH. A stylesheet in `document.head` does not apply
 * inside a shadow root -- style encapsulation cuts both ways -- so a renderer
 * that injects its CSS the usual way draws a completely unstyled calendar
 * once we mount it in shadow DOM. It still emits correct markup and correct
 * text, which is exactly why a test asserting on text content passes while
 * the grid is visibly broken.
 *
 * `adoptedStyleSheets` rather than a <style> element, because it is not
 * subject to `style-src` and therefore survives a host CSP that forbids
 * inline styles -- which is the case phase 4.8 exists to cover. Falls back to
 * a <style> element where constructable stylesheets are unavailable.
 *
 * Kept behind the seam: each adapter knows its own CSS, so the interface does
 * not have to grow a `styles` member that every future renderer must answer.
 */
const adopted = new WeakMap<ShadowRoot | Document, Set<string>>();

export function adoptStyles(host: HTMLElement, css: string, key: string): void {
  const root = host.getRootNode();
  if (!(root instanceof ShadowRoot)) return; // already in the document

  const seen = adopted.get(root) ?? new Set<string>();
  if (seen.has(key)) return;
  seen.add(key);
  adopted.set(root, seen);

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    root.append(style);
  }
}


/** Stable identity for an occurrence, since recurring instances share an eventId. */
export function occurrenceKey(occurrence: EventOccurrence): string {
  return occurrence.recurrenceId
    ? `${occurrence.eventId}::${occurrence.recurrenceId}`
    : occurrence.eventId;
}
