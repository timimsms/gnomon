import '@event-calendar/core/index.css';
import type { EventOccurrence } from '@gnomon/core';
import { eventCalendarAdapter } from '../../src/adapters/event-calendar.js';
import { fullCalendarAdapter } from '../../src/adapters/fullcalendar.js';
import type { MountOptions, RendererAdapter, RendererAdapterFactory, ViewName } from '../../src/adapter.js';

/**
 * The conformance harness.
 *
 * Exposes one control surface, driven only by an adapter NAME. The suite
 * never imports a renderer, never branches on which one is loaded, and never
 * reaches past this API -- so a test passing against both adapters is
 * evidence that the seam holds, rather than evidence that two similar test
 * files were written.
 */

const FACTORIES: Record<string, RendererAdapterFactory> = {
  'event-calendar': eventCalendarAdapter,
  fullcalendar: fullCalendarAdapter,
};

interface Harness {
  /**
   * Creating and mounting are separate, because the adapter must retain
   * events set BEFORE it is on screen -- the component sets them as soon as a
   * fetch resolves, which can precede attachment. A harness that only exposed
   * a combined call could not express that, and would also hide a double
   * mount by quietly building a second adapter.
   */
  create(name: string): void;
  mountCreated(options: MountOptions): void;
  mount(name: string, options: MountOptions): void;
  destroy(): void;
  release(): void;
  setEvents(occurrences: EventOccurrence[]): void;
  setView(view: ViewName): void;
  setDate(date: string): void;
  refresh(): void;
  emitted(): { type: string; payload: unknown }[];
  clearEmitted(): void;
  adapterName(): string | null;
  unsubscribeAll(): void;
}

let adapter: RendererAdapter | null = null;
let name: string | null = null;
let emitted: { type: string; payload: unknown }[] = [];
let unsubscribes: (() => void)[] = [];

const harness: Harness = {
  create(adapterName) {
    const factory = FACTORIES[adapterName];
    if (!factory) throw new Error(`Unknown adapter: ${adapterName}`);

    adapter = factory.create();
    name = adapterName;
    emitted = [];

    // Subscribed BEFORE mount, so a renderer that emits its first
    // `rangeChange` during construction is not silently missed. One of the
    // two does exactly that.
    for (const type of ['occurrenceClick', 'dateClick', 'rangeChange'] as const) {
      unsubscribes.push(
        adapter.on(type, (payload) => {
          emitted.push({ type, payload });
        }),
      );
    }
  },

  mountCreated(options) {
    if (!adapter) throw new Error('No adapter created');
    const host = document.querySelector<HTMLElement>('#host');
    if (!host) throw new Error('No #host element');
    adapter.mount(host, options);
  },

  mount(adapterName, options) {
    harness.create(adapterName);
    harness.mountCreated(options);
  },

  destroy() {
    // The reference is NOT cleared. Clearing it would make a second call
    // short-circuit here, and the harness's own optional-chaining would then
    // mask an adapter that is missing its idempotency guard -- which is
    // exactly what happened before this comment existed.
    adapter?.destroy();
  },

  /** Drops the adapter. Separate from destroy() for the reason above. */
  release() {
    adapter = null;
    name = null;
  },

  setEvents(occurrences) {
    adapter?.setEvents(occurrences);
  },
  setView(view) {
    adapter?.setView(view);
  },
  setDate(date) {
    adapter?.setDate(date);
  },
  refresh() {
    adapter?.refresh();
  },

  emitted: () => emitted,
  clearEmitted() {
    emitted = [];
  },
  adapterName: () => name,
  unsubscribeAll() {
    for (const off of unsubscribes) off();
    unsubscribes = [];
  },
};

declare global {
  interface Window {
    gnomonHarness: Harness;
  }
}

window.gnomonHarness = harness;
