import { expect, test, type Page } from '@playwright/test';

/**
 * The adapter conformance suite (ADR-0003, phase 4.3).
 *
 * ONE suite, run against EVERY adapter, driven only by a name. Nothing here
 * imports a renderer or branches on which one is loaded. That is the whole
 * design: if these assertions pass for both implementations, the interface is
 * a seam. If they had to be written twice, it would be a guess.
 *
 * When a third adapter appears, it is added to this array and nothing else
 * changes. If that turns out not to be true, the interface leaked.
 */
const ADAPTERS = ['event-calendar', 'fullcalendar'] as const;

/** March 2026 -- the month containing the US spring-forward. */
const MOUNT = {
  view: 'month' as const,
  date: '2026-03-01',
  timeZone: 'America/New_York',
};

const OCCURRENCES = [
  {
    eventId: 'evt-1',
    calendarId: 'cal-1',
    recurrenceId: '2026-03-08T14:00:00Z',
    title: 'Boiler inspection',
    timing: {
      kind: 'timed',
      start: '2026-03-08T09:00:00',
      end: '2026-03-08T10:00:00',
      timeZone: 'America/New_York',
    },
    isOverride: false,
  },
  {
    eventId: 'evt-2',
    calendarId: 'cal-1',
    title: 'Spring holiday',
    timing: { kind: 'allDay', startDate: '2026-03-17', endDate: '2026-03-18' },
    isOverride: false,
  },
];

async function mount(page: Page, adapter: string, overrides: Record<string, unknown> = {}) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.gnomonHarness));
  await page.evaluate(
    ([name, options]) => window.gnomonHarness.mount(name as string, options as never),
    [adapter, { ...MOUNT, ...overrides }] as const,
  );
}

const setEvents = (page: Page, occurrences: unknown[] = OCCURRENCES) =>
  page.evaluate((list) => window.gnomonHarness.setEvents(list as never), occurrences);

const emitted = (page: Page) => page.evaluate(() => window.gnomonHarness.emitted());

for (const adapter of ADAPTERS) {
  test.describe(`RendererAdapter conformance: ${adapter}`, () => {
    test('mount renders something visible without further calls', async ({ page }) => {
      // The interface promises mount() means "on screen". One renderer draws
      // on construction and the other needs an explicit render(); the adapter
      // is what makes that difference invisible here.
      await mount(page, adapter);
      const host = page.locator('#host');
      await expect(host).not.toBeEmpty();
      expect((await host.boundingBox())?.height).toBeGreaterThan(100);
    });

    test('setEvents renders occurrence titles', async ({ page }) => {
      await mount(page, adapter);
      await setEvents(page);
      await expect(page.locator('#host')).toContainText('Boiler inspection');
      await expect(page.locator('#host')).toContainText('Spring holiday');
    });

    test('setEvents replaces rather than appends', async ({ page }) => {
      // The obvious implementation of "add these events" leaves the previous
      // set behind. Both renderers needed different code to avoid it.
      await mount(page, adapter);
      await setEvents(page);
      await expect(page.locator('#host')).toContainText('Boiler inspection');

      await setEvents(page, [
        { ...OCCURRENCES[0], eventId: 'evt-3', recurrenceId: undefined, title: 'Replaced' },
      ]);

      await expect(page.locator('#host')).toContainText('Replaced');
      await expect(page.locator('#host')).not.toContainText('Boiler inspection');
    });

    test('setEvents before mount is retained and shown on mount', async ({ page }) => {
      // The component sets events as soon as a fetch resolves, which can be
      // before the element is attached. Losing them would show an empty
      // calendar that never recovers, with nothing to retry.
      await page.goto('/');
      await page.waitForFunction(() => Boolean(window.gnomonHarness));
      await page.evaluate(
        ([name, options, list]) => {
          window.gnomonHarness.create(name as string);
          window.gnomonHarness.setEvents(list as never); // before mount
          window.gnomonHarness.mountCreated(options as never);
        },
        [adapter, { ...MOUNT, date: '2026-03-08' }, OCCURRENCES] as const,
      );
      await expect(page.locator('#host')).toContainText('Boiler inspection');
    });

    test('setView switches between month and agenda', async ({ page }) => {
      // Opened on the event's own week, because the agenda view shows a week
      // rather than a month -- both renderers agree on that, so a fixture
      // dated 1 March would show an empty agenda for an event on the 8th and
      // the test would be asserting the wrong thing.
      await mount(page, adapter, { date: '2026-03-08' });
      await setEvents(page);

      await page.evaluate(() => window.gnomonHarness.setView('agenda'));
      await expect(page.locator('#host')).toContainText('Boiler inspection');

      await page.evaluate(() => window.gnomonHarness.setView('month'));
      await expect(page.locator('#host')).toContainText('Boiler inspection');
    });

    test('setDate navigates to another month', async ({ page }) => {
      await mount(page, adapter);
      await setEvents(page);
      await expect(page.locator('#host')).toContainText('Boiler inspection');

      // July is far from the seeded March events, so they must disappear.
      await page.evaluate(() => window.gnomonHarness.setDate('2026-07-01'));
      await expect(page.locator('#host')).not.toContainText('Boiler inspection');
    });

    test('emits rangeChange with a view name on navigation', async ({ page }) => {
      await mount(page, adapter);
      await page.evaluate(() => window.gnomonHarness.clearEmitted());
      await page.evaluate(() => window.gnomonHarness.setDate('2026-07-01'));

      await expect
        .poll(async () => (await emitted(page)).filter((e) => e.type === 'rangeChange').length)
        .toBeGreaterThan(0);

      const change = (await emitted(page)).find((e) => e.type === 'rangeChange');
      const payload = change?.payload as { from: string; to: string; view: string };
      expect(payload.view).toBe('month');
      // Both bounds are ISO instants, whichever renderer produced them.
      expect(Date.parse(payload.from)).not.toBeNaN();
      expect(Date.parse(payload.to)).toBeGreaterThan(Date.parse(payload.from));
    });

    test('emits occurrenceClick carrying the original occurrence', async ({ page }) => {
      // The payload must be OUR domain object, not the renderer's event
      // model. A caller that had to know which renderer produced it would
      // make the seam pointless.
      await mount(page, adapter);
      await setEvents(page);
      await page.evaluate(() => window.gnomonHarness.clearEmitted());

      await page.locator('#host').getByText('Boiler inspection').first().click();

      await expect
        .poll(async () => (await emitted(page)).filter((e) => e.type === 'occurrenceClick').length)
        .toBeGreaterThan(0);

      const click = (await emitted(page)).find((e) => e.type === 'occurrenceClick');
      const payload = click?.payload as { occurrence: { eventId: string; timing: { kind: string } } };
      expect(payload.occurrence.eventId).toBe('evt-1');
      expect(payload.occurrence.timing.kind).toBe('timed');
    });

    test('destroy leaves the host empty and is safe to call twice', async ({ page }) => {
      // One renderer's destroy throws on a second call and the other returns
      // a promise. The interface promises idempotent synchronous teardown, so
      // both adapters are made to keep it -- a disconnectedCallback has
      // nowhere to put a rejected promise.
      await mount(page, adapter);
      await setEvents(page);

      const error = await page.evaluate(() => {
        try {
          window.gnomonHarness.destroy();
          window.gnomonHarness.destroy();
          return null;
        } catch (caught) {
          return String(caught);
        }
      });

      expect(error).toBeNull();
      await expect.poll(async () => (await page.locator('#host').innerHTML()).trim()).toBe('');
    });

    test('refresh after the host is resized does not throw or blank the view', async ({ page }) => {
      // `refresh()` exists because one renderer measures its container once
      // and needs telling the measurement went stale. Without a second
      // implementation it would have looked like a redundant method.
      await mount(page, adapter);
      await setEvents(page);

      await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('#host');
        if (host) host.style.width = '500px';
        window.gnomonHarness.refresh();
      });

      await expect(page.locator('#host')).toContainText('Boiler inspection');
    });

    test('mounting twice without destroy is refused rather than leaking a renderer', async ({ page }) => {
      await mount(page, adapter);
      // mountCreated, not mount: mounting the SAME adapter twice is the
      // hazard. Building a second adapter would silently leak the first
      // renderer's DOM and listeners.
      const error = await page.evaluate(
        (options) => {
          try {
            window.gnomonHarness.mountCreated(options as never);
            return null;
          } catch (caught) {
            return String(caught);
          }
        },
        MOUNT,
      );
      expect(error).toMatch(/already mounted/i);
    });

    test('an all-day occurrence is not shown as a timed one', async ({ page }) => {
      // ADR-0005 survives the flattening to the renderer's boolean model:
      // a floating date must not acquire a time on the way out.
      await mount(page, adapter);
      await setEvents(page, [OCCURRENCES[1]]);
      await expect(page.locator('#host')).toContainText('Spring holiday');
      // No time component rendered next to an all-day chip.
      await expect(page.locator('#host')).not.toContainText('12a');
    });
  });
}

test('the suite actually covers more than one implementation', () => {
  // ADR-0003: an adapter with one implementation is a guess. If this array
  // ever shrinks to one, the conformance suite stops proving anything and
  // this failure is the reminder.
  expect(ADAPTERS.length).toBeGreaterThanOrEqual(2);
});
