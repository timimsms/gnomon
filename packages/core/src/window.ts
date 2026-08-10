import type { QueryWindow } from './types.js';

/**
 * Expansion windows are the project's primary denial-of-service control.
 *
 * An unbounded `?from=0001-01-01&to=9999-12-31` against a
 * `FREQ=MINUTELY` rule will happily try to materialise ~5 billion
 * occurrences. Since embeds are public-facing by design and tokens are
 * handed out liberally by host portals, the window cap is enforced in
 * the domain layer rather than at the HTTP edge -- there must be no code
 * path that expands a rule without passing through here.
 */

export const MAX_WINDOW_DAYS = 400;

export class WindowTooLargeError extends Error {
  constructor(requestedDays: number) {
    super(
      `Requested expansion window of ${requestedDays} days exceeds the maximum of ${MAX_WINDOW_DAYS}.`,
    );
    this.name = 'WindowTooLargeError';
  }
}

export class InvalidWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWindowError';
  }
}

const MS_PER_DAY = 86_400_000;

/**
 * Validates a requested window and returns its span in whole days.
 *
 * Uses `Date` rather than `Temporal` deliberately: this is a coarse
 * span check on two instants, not calendar arithmetic, so it carries
 * none of the DST hazards that make `Date` unsafe elsewhere. Keeping it
 * dependency-free means the guard has no polyfill cost in the browser.
 */
export function assertWindow(window: QueryWindow): number {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);

  if (Number.isNaN(from)) {
    throw new InvalidWindowError(`Unparseable window start: ${window.from}`);
  }
  if (Number.isNaN(to)) {
    throw new InvalidWindowError(`Unparseable window end: ${window.to}`);
  }
  if (to <= from) {
    throw new InvalidWindowError('Window end must be strictly after window start.');
  }

  const days = Math.ceil((to - from) / MS_PER_DAY);
  if (days > MAX_WINDOW_DAYS) {
    throw new WindowTooLargeError(days);
  }

  return days;
}
