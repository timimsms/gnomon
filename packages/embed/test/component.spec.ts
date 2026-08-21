import { expect, test, type Page } from '@playwright/test';

/**
 * `<gnomon-calendar>` behaviour (phase 4.4, 4.6).
 *
 * The fixture page carries a deliberately hostile stylesheet -- `!important`
 * on `*`, on `div`, on `button` -- because that is the realistic case. A host
 * portal has a design system and did not write it with us in mind.
 *
 * The Gnomon API is mocked at the network layer rather than run for real:
 * phase 3 already proves the API, and what needs proving here is how the
 * element behaves when the network does something inconvenient.
 */

const OCCURRENCES = [
  {
    eventId: 'evt-1',
    calendarId: 'cal-1',
    title: 'Boiler inspection',
    timing: {
      kind: 'timed',
      start: '2026-03-10T09:00:00',
      end: '2026-03-10T10:00:00',
      timeZone: 'America/New_York',
    },
    isOverride: false,
  },
];

/** A JWT-shaped token whose `exp` the client can read. Never verified here. */
function fakeToken(expiresInSeconds: number): string {
  const b64 = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  return `${b64({ alg: 'EdDSA', kid: 'k' })}.${b64({ sub: 's', tid: 't', exp })}.sig`;
}

interface MockOptions {
  occurrences?: unknown[];
  tokenStatus?: number;
  /** Reject the first N /events calls with 401, to exercise refresh. */
  unauthorizedFirst?: number;
}

async function mockApi(page: Page, options: MockOptions = {}) {
  const state = { tokensIssued: 0, eventCalls: 0, unauthorized: options.unauthorizedFirst ?? 0 };

  await page.route('**/token', async (route) => {
    state.tokensIssued += 1;
    if (options.tokenStatus && options.tokenStatus !== 200) {
      await route.fulfill({ status: options.tokenStatus, body: 'nope' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ token: fakeToken(300) }),
    });
  });

  await page.route('**/events*', async (route) => {
    state.eventCalls += 1;
    if (state.unauthorized > 0) {
      state.unauthorized -= 1;
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unauthorized' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ occurrences: options.occurrences ?? OCCURRENCES }),
    });
  });

  return state;
}

const BASE_ATTRS = {
  api: 'https://gnomon.test/api',
  'token-endpoint': 'https://portal.test/token',
  date: '2026-03-10',
  tz: 'America/New_York',
};

async function mount(page: Page, attrs: Record<string, string> = {}) {
  await page.goto('/component.html');
  await page.waitForFunction(() => Boolean(window.gnomonTest));
  await page.evaluate((a) => window.gnomonTest.add(a), { ...BASE_ATTRS, ...attrs });
}

const calendar = (page: Page) => page.locator('gnomon-calendar');

test.describe('rendering and data', () => {
  test('fetches a token, loads events, and renders them', async ({ page }) => {
    const state = await mockApi(page);
    await mount(page);

    await expect(calendar(page)).toContainText('Boiler inspection');
    expect(state.tokensIssued).toBeGreaterThan(0);
  });

  test('shows chrome the element owns rather than the renderer\'s', async ({ page }) => {
    await mockApi(page);
    await mount(page);
    // Both adapters suppress their renderer's toolbar so the two look the
    // same; these controls come from the element.
    await expect(calendar(page).getByRole('button', { name: 'Today' })).toBeVisible();
    // exact: 'Previous month' and 'Next month' both contain 'Month'.
    await expect(calendar(page).getByRole('button', { name: 'Month', exact: true })).toBeVisible();
  });

  test('switches view without refetching', async ({ page }) => {
    const state = await mockApi(page);
    await mount(page);
    await expect(calendar(page)).toContainText('Boiler inspection');

    const before = state.eventCalls;
    await calendar(page).getByRole('button', { name: 'Agenda' }).click();
    await expect(calendar(page)).toContainText('Boiler inspection');

    // A view change is a rendering concern; the window did not move, so the
    // data must be reused rather than re-requested.
    expect(state.eventCalls).toBe(before);
  });

  test('navigating months refetches for the new window', async ({ page }) => {
    const state = await mockApi(page);
    await mount(page);
    await expect(calendar(page)).toContainText('Boiler inspection');

    const before = state.eventCalls;
    await calendar(page).getByRole('button', { name: 'Next month' }).click();
    await expect.poll(() => state.eventCalls).toBeGreaterThan(before);
  });
});

test.describe('Shadow DOM survives a hostile host stylesheet', () => {
  test('host !important rules do not reach inside', async ({ page }) => {
    await mockApi(page);
    await mount(page);
    await expect(calendar(page)).toContainText('Boiler inspection');

    const styles = await page.evaluate(() => {
      const el = document.querySelector('gnomon-calendar')!;
      const button = el.shadowRoot!.querySelector('button')!;
      const computed = getComputedStyle(button);
      const hostDiv = getComputedStyle(document.querySelector('#wrapper')!);
      return {
        insideFont: computed.fontFamily,
        insideTransform: computed.textTransform,
        insideBorder: computed.borderStyle,
        outsideFont: hostDiv.fontFamily,
      };
    });

    // The host page really is applying its rules -- otherwise this test would
    // pass against no encapsulation at all.
    expect(styles.outsideFont).toContain('Comic Sans');

    expect(styles.insideFont).not.toContain('Comic Sans');
    expect(styles.insideTransform).not.toBe('uppercase');
    expect(styles.insideBorder).not.toBe('dashed');
  });

  test('theme tokens set on the host element pierce the boundary', async ({ page }) => {
    await mockApi(page);
    await mount(page);
    await expect(calendar(page)).toContainText('Boiler inspection');

    const accent = await page.evaluate(() => {
      const el = document.querySelector('gnomon-calendar')! as HTMLElement;
      // Exactly what an integrator does: set one custom property, override
      // one thing, inherit the rest.
      el.style.setProperty('--gnomon-accent-colour', 'rgb(0, 128, 0)');
      const pressed = el.shadowRoot!.querySelector('button[aria-pressed="true"]')!;
      return getComputedStyle(pressed).backgroundColor;
    });

    expect(accent).toBe('rgb(0, 128, 0)');
  });
});

test.describe('token lifecycle', () => {
  test('refreshes and retries once when the server rejects a token', async ({ page }) => {
    // Clocks drift and tabs sleep, so a token can expire between mint and
    // use. That must be invisible rather than an error the user sees.
    const state = await mockApi(page, { unauthorizedFirst: 1 });
    await mount(page);

    await expect(calendar(page)).toContainText('Boiler inspection');
    expect(state.eventCalls).toBe(2);
    expect(state.tokensIssued).toBe(2);
  });

  test('degrades visibly when the token endpoint is unreachable', async ({ page }) => {
    // "Blank calendar" is not a diagnosis. The failure has to be legible on
    // screen AND available as an event, since a host may hide our UI.
    await mockApi(page, { tokenStatus: 500 });
    await mount(page);

    await expect(calendar(page).getByRole('alert')).toBeVisible();
    await expect(calendar(page).getByRole('alert')).toContainText(/token/i);
    await expect.poll(() => page.evaluate(() => window.gnomonTest.errors.length)).toBeGreaterThan(0);
  });

  test('reports a missing configuration rather than silently doing nothing', async ({ page }) => {
    await mockApi(page);
    await page.goto('/component.html');
    await page.waitForFunction(() => Boolean(window.gnomonTest));
    await page.evaluate(() => window.gnomonTest.add({ api: 'https://gnomon.test/api' }));

    await expect(calendar(page).getByRole('alert')).toContainText(/token/i);
  });
});

test.describe('the renderer seam holds at the component level', () => {
  for (const renderer of ['event-calendar', 'fullcalendar'] as const) {
    test(`renders identically through ${renderer}`, async ({ page }) => {
      // The component never names a renderer. Swapping one at runtime and
      // getting the same result is the seam working end to end, rather than
      // only in the adapter conformance suite.
      await mockApi(page);
      await mount(page);
      await expect(calendar(page)).toContainText('Boiler inspection');

      await page.evaluate((name) => {
        const el = document.querySelector('gnomon-calendar')!;
        window.gnomonTest.swapRenderer(el as never, name);
      }, renderer);

      await expect(calendar(page)).toContainText('Boiler inspection');
      await expect(calendar(page).getByRole('button', { name: 'Today' })).toBeVisible();
    });
  }
});

test.describe('multiple embeds on one page', () => {
  test('two calendars do not interfere', async ({ page }) => {
    // A portal showing "my building" and "community events" side by side is
    // the expected case, not an edge case.
    await mockApi(page);
    await page.goto('/component.html');
    await page.waitForFunction(() => Boolean(window.gnomonTest));

    await page.evaluate((attrs) => {
      window.gnomonTest.add({ ...attrs, calendars: 'cal-1' });
      window.gnomonTest.add({ ...attrs, calendars: 'cal-2', view: 'agenda' });
    }, BASE_ATTRS);

    await expect(calendar(page)).toHaveCount(2);
    await expect(calendar(page).nth(0)).toContainText('Boiler inspection');
    await expect(calendar(page).nth(1)).toContainText('Boiler inspection');

    // Each keeps its own view state.
    const pressed = await page.evaluate(() =>
      [...document.querySelectorAll('gnomon-calendar')].map(
        (el) => el.shadowRoot!.querySelector('button[aria-pressed="true"]')?.textContent?.trim(),
      ),
    );
    expect(pressed[0]).toBe('Month');
    expect(pressed[1]).toBe('Agenda');
  });

  test('defining the element twice does not throw', async ({ page }) => {
    // Two copies of the loader on one page is a realistic accident, and the
    // second must not take the host's script down with it.
    await page.goto('/component.html');
    await page.waitForFunction(() => Boolean(window.gnomonTest));
    const error = await page.evaluate(() => {
      try {
        window.gnomonTest.defineAgain();
        window.gnomonTest.defineAgain();
        return null;
      } catch (caught) {
        return String(caught);
      }
    });
    expect(error).toBeNull();
  });
});

test.describe('teardown', () => {
  test('removing the element aborts in-flight work without throwing', async ({ page }) => {
    // A fetch resolving into a destroyed renderer is the classic
    // detached-element crash.
    await mockApi(page);
    await mount(page);
    await expect(calendar(page)).toContainText('Boiler inspection');

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.evaluate(() => {
      document.querySelectorAll('gnomon-calendar').forEach((el) => el.remove());
    });

    await expect(calendar(page)).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});
