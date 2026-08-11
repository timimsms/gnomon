/**
 * ICS interop. **Node only** -- see ADR-0008.
 *
 * Reached as `@gnomon/core/ics`, deliberately not from the package's main
 * entry: `node-ical` imports `node:fs`, and pulling that into the main export
 * would put it in every browser bundle and break L9.
 *
 * Serialisation here is pure and would run anywhere; it is grouped with the
 * parser because ICS interop is one coherent surface.
 */

export type { ParsedCalendar, ParsedEvent } from './parse.js';
export { parseCalendar } from './parse.js';

export type { SerializeInput } from './serialize.js';
export {
  canonicalRRule,
  compactDate,
  compactDateTime,
  compactOffset,
  escapeText,
  foldLine,
  serializeCalendar,
} from './serialize.js';
