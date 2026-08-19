import '@event-calendar/core/index.css';
import { defineGnomonCalendar, type GnomonCalendar } from '../../src/component.js';
import { fullCalendarAdapter } from '../../src/adapters/fullcalendar.js';
import { eventCalendarAdapter } from '../../src/adapters/event-calendar.js';

defineGnomonCalendar();

declare global {
  interface Window {
    gnomonTest: {
      add(attrs: Record<string, string>): GnomonCalendar;
      swapRenderer(el: GnomonCalendar, name: string): void;
      defineAgain(): void;
      errors: string[];
    };
  }
}

const errors: string[] = [];
window.addEventListener('gnomon-error', (e) => {
  errors.push((e as CustomEvent<{ message: string }>).detail.message);
});

window.gnomonTest = {
  add(attrs) {
    const el = document.createElement('gnomon-calendar');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.querySelector('#wrapper')!.append(el);
    return el;
  },
  // Exposed here rather than dynamically imported from the spec: the Vite
  // root is this fixture directory, so /src/... is not addressable from the
  // page.
  defineAgain() {
    defineGnomonCalendar();
  },
  swapRenderer(el, name) {
    el.setRendererAdapter(name === 'fullcalendar' ? fullCalendarAdapter : eventCalendarAdapter);
  },
  errors,
};
