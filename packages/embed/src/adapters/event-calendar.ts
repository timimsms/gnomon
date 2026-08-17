import { DayGrid, List, createCalendar, destroyCalendar } from '@event-calendar/core';
import type { EventOccurrence } from '@gnomon/core';
import {
  EventBus,
  occurrenceKey,
  toRendererTiming,
  type MountOptions,
  type RendererAdapter,
  type RendererAdapterFactory,
  type RendererEventName,
  type RendererEvents,
  type Unsubscribe,
  type ViewName,
} from '../adapter.js';
import type { ThemeTokens } from '../theme.js';

/**
 * The launch renderer (L3, ADR-0003).
 *
 * `@event-calendar` is MIT with a zero-dependency bundle and -- critically --
 * NO premium tier at all, so there is nothing that can be moved behind a
 * paywall later. That property is why it is the default rather than the
 * larger-ecosystem option.
 *
 * The only module in the codebase permitted to import `@event-calendar`.
 */

/** Our two views, in this renderer's vocabulary. */
const VIEWS: Record<ViewName, string> = {
  month: 'dayGridMonth',
  agenda: 'listWeek',
};

interface EcEvent {
  id: string;
  start: Date | string;
  end: Date | string;
  allDay: boolean;
  title: string;
  extendedProps: { occurrence: EventOccurrence };
}

type EcCalendar = ReturnType<typeof createCalendar>;

class EventCalendarAdapter implements RendererAdapter {
  readonly #bus = new EventBus();
  #calendar: EcCalendar | null = null;
  #occurrences: readonly EventOccurrence[] = [];
  #view: ViewName = 'month';

  mount(host: HTMLElement, options: MountOptions): void {
    if (this.#calendar) throw new Error('Adapter already mounted; call destroy() first.');
    this.#view = options.view;

    this.#calendar = createCalendar(host, [DayGrid, List], {
      view: VIEWS[options.view],
      date: options.date,
      events: this.#toEcEvents(this.#occurrences),
      // The renderer is told which zone to draw in; it never resolves
      // recurrence, which happened server-side in @gnomon/core.
      timeZone: options.timeZone,
      ...(options.locale ? { locale: options.locale } : {}),
      height: '100%',
      // Suppressed: the component owns navigation, so that both adapters
      // present the same chrome rather than each renderer's own.
      headerToolbar: { start: '', center: '', end: '' },

      eventClick: (info: { event: { extendedProps?: { occurrence?: EventOccurrence } } }) => {
        const occurrence = info.event.extendedProps?.occurrence;
        if (occurrence) this.#bus.emit('occurrenceClick', { occurrence });
      },
      dateClick: (info: { date: Date }) => {
        this.#bus.emit('dateClick', { date: isoDate(info.date) });
      },
      datesSet: (info: { start: Date; end: Date }) => {
        this.#bus.emit('rangeChange', {
          from: info.start.toISOString(),
          to: info.end.toISOString(),
          view: this.#view,
        });
      },
    });
  }

  destroy(): void {
    if (!this.#calendar) return;
    // Async in this renderer (Svelte teardown), but the interface is
    // synchronous because every caller wants "stop touching my DOM", not a
    // promise to await. Errors are swallowed rather than thrown from a
    // teardown path a disconnectedCallback cannot handle.
    void destroyCalendar(this.#calendar).catch(() => {});
    this.#calendar = null;
    this.#bus.clear();
  }

  setEvents(occurrences: readonly EventOccurrence[]): void {
    this.#occurrences = occurrences;
    this.#calendar?.setOption('events', this.#toEcEvents(occurrences) as never);
  }

  setView(view: ViewName): void {
    this.#view = view;
    this.#calendar?.setOption('view', VIEWS[view] as never);
  }

  setDate(date: string): void {
    this.#calendar?.setOption('date', date as never);
  }

  setTheme(_tokens: ThemeTokens): void {
    // Nothing to do: this renderer is styled entirely by CSS custom
    // properties supplied through the Shadow DOM, so the tokens reach it
    // without the adapter passing anything along. Kept as a no-op rather
    // than omitted, because the interface is the contract and a renderer
    // that DOES need imperative theming has somewhere to put it.
  }

  on<E extends RendererEventName>(
    event: E,
    handler: (payload: RendererEvents[E]) => void,
  ): Unsubscribe {
    return this.#bus.on(event, handler);
  }

  refresh(): void {
    // Re-setting the events forces a re-layout, which is what a host needs
    // after un-hiding the element. There is no public relayout hook.
    this.#calendar?.setOption('events', this.#toEcEvents(this.#occurrences) as never);
  }

  #toEcEvents(occurrences: readonly EventOccurrence[]): EcEvent[] {
    return occurrences.map((occurrence) => {
      const timing = toRendererTiming(occurrence);
      return {
        id: occurrenceKey(occurrence),
        start: timing.start,
        end: timing.end,
        allDay: timing.allDay,
        title: occurrence.title,
        extendedProps: { occurrence },
      };
    });
  }
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const pad = (value: number) => String(value).padStart(2, '0');

export const eventCalendarAdapter: RendererAdapterFactory = {
  name: 'event-calendar',
  create: () => new EventCalendarAdapter(),
};
