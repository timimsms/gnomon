import { describe, expect, it } from 'vitest';
import {
  assertWindow,
  InvalidWindowError,
  MAX_WINDOW_DAYS,
  WindowTooLargeError,
} from '../src/window.js';

describe('assertWindow', () => {
  it('accepts a normal month-long window', () => {
    expect(
      assertWindow({ from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }),
    ).toBe(31);
  });

  it('accepts a window exactly at the cap', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date(from.getTime() + MAX_WINDOW_DAYS * 86_400_000);
    expect(
      assertWindow({ from: from.toISOString(), to: to.toISOString() }),
    ).toBe(MAX_WINDOW_DAYS);
  });

  it('rejects a window one day past the cap', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date(from.getTime() + (MAX_WINDOW_DAYS + 1) * 86_400_000);
    expect(() =>
      assertWindow({ from: from.toISOString(), to: to.toISOString() }),
    ).toThrow(WindowTooLargeError);
  });

  it('rejects the unbounded-range DoS shape', () => {
    expect(() =>
      assertWindow({ from: '0001-01-01T00:00:00Z', to: '9999-12-31T00:00:00Z' }),
    ).toThrow(WindowTooLargeError);
  });

  it('rejects an inverted window', () => {
    expect(() =>
      assertWindow({ from: '2026-11-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }),
    ).toThrow(InvalidWindowError);
  });

  it('rejects a zero-width window', () => {
    expect(() =>
      assertWindow({ from: '2026-10-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }),
    ).toThrow(InvalidWindowError);
  });

  it('rejects unparseable bounds', () => {
    expect(() => assertWindow({ from: 'yesterday', to: '2026-10-01T00:00:00Z' })).toThrow(
      InvalidWindowError,
    );
  });

  it('counts a DST-spanning window in whole days without drift', () => {
    // 2026-11-01 is the US fall-back date. A wall-clock month here is
    // 30 days plus one hour; the guard must not round that to 31.
    expect(
      assertWindow({ from: '2026-10-15T00:00:00Z', to: '2026-11-14T01:00:00Z' }),
    ).toBe(31);
  });
});
