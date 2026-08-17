import { Calendar } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import listPlugin from '@fullcalendar/list';
// SEAM FINDING 4: `dateClick` is core in one renderer and a separate plugin
// here. The interface promises the event either way, so the adapter pays the
// cost of the difference -- which is the whole argument for having one.
import interactionPlugin from '@fullcalendar/interaction';
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
 * The second adapter (ADR-0003, phase 4.3).
 *
 * This produces no user-visible feature, and that is the point. An adapter
 * with one implementation is a guess; an adapter with two is a seam. Deferring
 * it would mean discovering, at the worst possible moment, that the interface
 * had quietly absorbed `@event-calendar`'s assumptions.
 *
 * It found three while being written -- see the notes below on teardown,
 * navigation and initial size. Each cost a few lines here rather than a
 * redesign later.
 *
 * FullCalendar STANDARD only: `@fullcalendar/core`, `daygrid`, `list`, all
 * MIT. Premium packages moved to AGPLv3 in v7 and must never appear here;
 * the licence gate (ADR-0002) is the backstop, this comment is the intent.
 *
 * Pinned to the 6.x line because 7.x has a stable `core` but its `daygrid`
 * and `list` plugins are still release candidates, and mixing majors is not
 * supported.
 */

const VIEWS: Record<ViewName, string> = {
  month: 'dayGridMonth',
  agenda: 'listWeek',
};

class FullCalendarAdapter implements RendererAdapter {
  readonly #bus = new EventBus();
  #calendar: Calendar | null = null;
  #occurrences: readonly EventOccurrence[] = [];
  #view: ViewName = 'month';

  mount(host: HTMLElement, options: MountOptions): void {
    if (this.#calendar) throw new Error('Adapter already mounted; call destroy() first.');
    this.#view = options.view;

    this.#calendar = new Calendar(host, {
      plugins: [dayGridPlugin, listPlugin, interactionPlugin],
      initialView: VIEWS[options.view],
      initialDate: options.date,
      timeZone: options.timeZone,
      ...(options.locale ? { locale: options.locale } : {}),
      height: '100%',
      headerToolbar: false,
      events: this.#toFcEvents(this.#occurrences),

      eventClick: (info) => {
        const occurrence = info.event.extendedProps.occurrence as EventOccurrence | undefined;
        if (occurrence) this.#bus.emit('occurrenceClick', { occurrence });
      },
      dateClick: (info: { dateStr: string }) => {
        this.#bus.emit('dateClick', { date: info.dateStr.slice(0, 10) });
      },
      datesSet: (info) => {
        this.#bus.emit('rangeChange', {
          from: info.start.toISOString(),
          to: info.end.toISOString(),
          view: this.#view,
        });
      },
    });

    // SEAM FINDING 1: this renderer needs an explicit render() before it
    // draws anything, where the other draws on construction. The interface
    // stays "mount() means it is on screen"; hiding the difference is the
    // adapter's job, which is exactly what an adapter is for.
    this.#calendar.render();
  }

  destroy(): void {
    // SEAM FINDING 2: destroy() here is synchronous and throws if called
    // twice, where the other returns a promise. The interface promises
    // idempotent, synchronous teardown, so both are made to keep it.
    if (!this.#calendar) return;
    this.#calendar.destroy();
    this.#calendar = null;
    this.#bus.clear();
  }

  setEvents(occurrences: readonly EventOccurrence[]): void {
    this.#occurrences = occurrences;
    if (!this.#calendar) return;
    // removeAllEvents + addEventSource rather than a setter: FullCalendar has
    // no single "replace the event set" call, and mutating the existing
    // source leaves stale instances behind.
    this.#calendar.removeAllEvents();
    this.#calendar.addEventSource(this.#toFcEvents(occurrences));
  }

  setView(view: ViewName): void {
    this.#view = view;
    this.#calendar?.changeView(VIEWS[view]);
  }

  setDate(date: string): void {
    this.#calendar?.gotoDate(date);
  }

  setTheme(_tokens: ThemeTokens): void {
    // As with the other adapter: themed through CSS custom properties, which
    // reach the renderer without the adapter forwarding anything.
  }

  on<E extends RendererEventName>(
    event: E,
    handler: (payload: RendererEvents[E]) => void,
  ): Unsubscribe {
    return this.#bus.on(event, handler);
  }

  refresh(): void {
    // SEAM FINDING 3: this renderer measures its container on render and
    // needs telling when that measurement went stale -- the case the other
    // handles implicitly. `updateSize` is why `refresh()` is in the
    // interface at all; without a second implementation it would have looked
    // like a redundant method.
    this.#calendar?.updateSize();
  }

  #toFcEvents(occurrences: readonly EventOccurrence[]) {
    return occurrences.map((occurrence) => {
      const timing = toRendererTiming(occurrence);
      return {
        id: occurrenceKey(occurrence),
        title: occurrence.title,
        start: timing.start,
        end: timing.end,
        allDay: timing.allDay,
        extendedProps: { occurrence },
      };
    });
  }
}

export const fullCalendarAdapter: RendererAdapterFactory = {
  name: 'fullcalendar',
  create: () => new FullCalendarAdapter(),
};
