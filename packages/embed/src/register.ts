/**
 * The bundle entry the loader imports.
 *
 * Side-effecting on purpose: the loader's whole job is to get
 * <gnomon-calendar> defined, and an entry that exported a function to call
 * would put one more step in the file every integrator pastes.
 */
import { defineGnomonCalendar } from './component.js';

defineGnomonCalendar();

export { GnomonCalendar, defineGnomonCalendar } from './component.js';
export { eventCalendarAdapter } from './adapters/event-calendar.js';
