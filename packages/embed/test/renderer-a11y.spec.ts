import { expect, test } from '@playwright/test';

/**
 * What the RENDERERS contribute to accessibility (phase 7.1).
 *
 * Separate from `accessibility.spec.ts` because the split matters: the
 * component's chrome, announcements and focus behaviour are ours to fix, and
 * the month grid's ARIA semantics are not. ADR-0003 anticipated exactly this
 * — "where the renderer's semantics are inadequate, the finding goes in an
 * ADR, because it is evidence about adapter choice."
 *
 * These tests assert the CURRENT, MEASURED behaviour of each renderer rather
 * than an aspiration. When a renderer improves, one of them fails, and that
 * failure is the news.
 */

const MOUNT = { view: 'month' as const, date: '2026-03-01', timeZone: 'America/New_York' };

async function snapshot(page: import('@playwright/test').Page, adapter: string) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.gnomonHarness));
  await page.evaluate(
    ([name, options]) => window.gnomonHarness.mount(name as string, options as never),
    [adapter, MOUNT] as const,
  );
  await expect(page.locator('#host')).not.toBeEmpty();
  return page.locator('#host').ariaSnapshot();
}

const count = (snap: string, pattern: RegExp) => (snap.match(pattern) ?? []).length;

test.describe('FullCalendar exposes a real grid', () => {
  test('rows contain the cells, and cells carry their date', async ({ page }) => {
    const snap = await snapshot(page, 'fullcalendar');

    expect(snap).toContain('- grid');
    // Seven header columns plus six week rows.
    expect(count(snap, /- row/g)).toBeGreaterThan(5);
    expect(count(snap, /- gridcell/g)).toBeGreaterThan(27);
    // The accessible name is the full date, so a screen reader says
    // "March 1, 2026" rather than "1".
    expect(snap).toMatch(/gridcell "March \d+, 2026"/);
  });
});

test.describe('@event-calendar does not', () => {
  /**
   * MEASURED, not assumed, from the computed ARIA tree:
   *
   *   - the container is `table`, not `grid`
   *   - there is exactly ONE row, the header
   *   - all 35 day cells are ORPHANED -- `role="cell"` with no `role="row"`
   *     ancestor, which is invalid ARIA
   *   - cell names are bare numbers: "1", "2", with no date and no row
   *     context
   *
   * The practical effect is that the month grid is not navigable by screen
   * reader. This is a defect in the renderer, not in the adapter, and it is
   * not fixable from outside: the renderer re-renders its own DOM on every
   * navigation and event change, so any post-processing we did would be
   * undone moments later.
   */
  test('has cells that are not inside rows', async ({ page }) => {
    const snap = await snapshot(page, 'event-calendar');

    expect(snap).toContain('- table');
    // One row: the header. Were this to rise, the renderer has been fixed.
    expect(count(snap, /- row/g)).toBe(1);
    expect(count(snap, /- cell/g)).toBeGreaterThan(27);
  });

  test('names day cells by number alone, with no date', async ({ page }) => {
    const snap = await snapshot(page, 'event-calendar');

    // A screen reader announces "cell 1" with no month, year or weekday.
    expect(snap).toMatch(/- cell "\d+"/);
    expect(snap).not.toMatch(/cell "March \d+, 2026"/);
  });
});

test('the gap between the two renderers is real and measured', async ({ page }) => {
  // The single assertion this suite exists to make. If it ever fails because
  // @event-calendar improved, that is the signal to revisit ADR-0003's
  // accessibility note -- and to delete this test.
  const ec = await snapshot(page, 'event-calendar');
  const fc = await snapshot(page, 'fullcalendar');

  expect(count(fc, /- row/g)).toBeGreaterThan(count(ec, /- row/g));
});
