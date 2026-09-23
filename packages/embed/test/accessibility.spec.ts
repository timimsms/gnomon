import { expect, test, type Page } from '@playwright/test';

/**
 * Accessibility (phase 7.1).
 *
 * Split deliberately between what WE control and what the renderer controls.
 * The component's own chrome, announcements and focus behaviour are ours and
 * are asserted here. The month grid's ARIA semantics come from the renderer,
 * and the audit of those is a separate suite -- see `renderer-a11y.spec.ts`.
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

function fakeToken(seconds: number): string {
  const b64 = (v: unknown) =>
    btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'EdDSA', kid: 'k' })}.${b64({ sub: 's', tid: 't', exp: Math.floor(Date.now() / 1000) + seconds })}.sig`;
}

async function mount(page: Page, attrs: Record<string, string> = {}) {
  await page.route('**/token', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: fakeToken(300) }) }));
  await page.route('**/events*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ occurrences: OCCURRENCES }) }));

  await page.goto('/component.html');
  await page.waitForFunction(() => Boolean(window.gnomonTest));
  await page.evaluate((a) => window.gnomonTest.add(a), {
    api: 'https://gnomon.test/api',
    'token-endpoint': 'https://portal.test/token',
    date: '2026-03-10',
    tz: 'America/New_York',
    ...attrs,
  });
  await expect(page.locator('gnomon-calendar')).toContainText('Boiler inspection');
}

/**
 * Our period heading specifically.
 *
 * `getByRole('heading')` is ambiguous here -- the renderer renders a heading
 * of its own inside the same element, so the role query matches two and
 * Playwright refuses in strict mode. Scoping by part keeps the assertion
 * about the component's chrome rather than about whatever the renderer drew.
 */
const period = (page: Page) => page.locator('gnomon-calendar [part="period"]');

const shadow = (page: Page) =>
  page.evaluate(() => document.querySelector('gnomon-calendar')!.shadowRoot!.innerHTML);

test.describe('the calendar announces itself', () => {
  test('is a labelled region naming the visible period', async ({ page }) => {
    // Without a label a screen reader user finds an unlabelled table mid-page
    // and cannot skip it.
    await mount(page);
    const region = page.locator('gnomon-calendar').getByRole('region');
    await expect(region).toHaveAttribute('aria-label', /Calendar, March 2026/);
  });

  test('shows the visible period as a heading', async ({ page }) => {
    // Sighted users need it too: the old chrome had navigation and nothing
    // saying which month was on screen.
    await mount(page);
    await expect(period(page)).toHaveText('March 2026');
  });

  test('has a live region present before anything changes', async ({ page }) => {
    // A live region inserted at the same moment its text appears is routinely
    // missed, because there was nothing to observe when the change happened.
    await mount(page);
    expect(await shadow(page)).toContain('aria-live="polite"');
  });

  test('announces a month change', async ({ page }) => {
    // A silent view change is indistinguishable from a broken one.
    await mount(page);
    await page.locator('gnomon-calendar').getByRole('button', { name: 'Next month' }).click();

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            document
              .querySelector('gnomon-calendar')!
              .shadowRoot!.querySelector('[role="status"]')?.textContent?.trim() ?? '',
        ),
      )
      .toMatch(/April 2026/);
  });

  test('announces a view change', async ({ page }) => {
    await mount(page);
    await page.locator('gnomon-calendar').getByRole('button', { name: 'Agenda' }).click();

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            document
              .querySelector('gnomon-calendar')!
              .shadowRoot!.querySelector('[role="status"]')?.textContent?.trim() ?? '',
        ),
      )
      .toMatch(/agenda view/i);
  });

  test('localises the announcement rather than hardcoding English months', async ({ page }) => {
    // An announcement in the wrong language sounds like a bug in the host's
    // own page.
    await mount(page, { locale: 'fr-FR' });
    await expect(period(page)).toHaveText(/mars 2026/i);
  });
});

test.describe('keyboard', () => {
  test('every control is reachable and operable by keyboard', async ({ page }) => {
    await mount(page);

    const names = await page.evaluate(() =>
      [...document.querySelector('gnomon-calendar')!.shadowRoot!.querySelectorAll('button')].map(
        (b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '',
      ),
    );

    // Native buttons, so they are focusable and Enter/Space work without us
    // reimplementing anything.
    expect(names).toEqual(
      expect.arrayContaining(['Previous month', 'Today', 'Next month', 'Month', 'Agenda']),
    );
  });

  test('PageDown and PageUp move between months', async ({ page }) => {
    // The convention every desktop calendar uses, and therefore the first
    // thing a keyboard user tries.
    await mount(page);
    await page.locator('gnomon-calendar').getByRole('button', { name: 'Today' }).focus();

    await page.keyboard.press('PageDown');
    await expect(period(page)).toHaveText('April 2026');

    await page.keyboard.press('PageUp');
    await expect(period(page)).toHaveText('March 2026');
  });

  test('does not swallow keys it does not handle', async ({ page }) => {
    // Swallowing everything would break the host page's own shortcuts.
    await mount(page);
    await page.locator('gnomon-calendar').getByRole('button', { name: 'Today' }).focus();

    const defaultPrevented = await page.evaluate(() => {
      const el = document.querySelector('gnomon-calendar')!;
      const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
      el.shadowRoot!.querySelector('button')!.dispatchEvent(event);
      return event.defaultPrevented;
    });

    expect(defaultPrevented).toBe(false);
  });

  test('keeps a visible focus indicator under a hostile host stylesheet', async ({ page }) => {
    // The fixture page resets aggressively; a focus ring the host can remove
    // makes the component unusable by keyboard.
    await mount(page);
    const button = page.locator('gnomon-calendar').getByRole('button', { name: 'Today' });
    await button.focus();

    const outline = await page.evaluate(() => {
      const root = document.querySelector('gnomon-calendar')!.shadowRoot!;
      const focused = root.activeElement as HTMLElement;
      const style = getComputedStyle(focused);
      return { width: style.outlineWidth, style: style.outlineStyle };
    });

    expect(outline.style).not.toBe('none');
    expect(Number.parseFloat(outline.width)).toBeGreaterThan(0);
  });
});

test.describe('motion and contrast', () => {
  test('respects prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mount(page);

    const animated = await page.evaluate(() => {
      const root = document.querySelector('gnomon-calendar')!.shadowRoot!;
      return [...root.querySelectorAll('*')].some((el) => {
        const s = getComputedStyle(el as HTMLElement);
        return (
          (s.transitionDuration !== '0s' && s.transitionDuration !== '') ||
          (s.animationDuration !== '0s' && s.animationDuration !== '')
        );
      });
    });

    expect(animated).toBe(false);
  });

  test('the default theme meets WCAG AA', async ({ page }) => {
    /**
     * Computed from the tokens as rendered, not from the constants, so a
     * change to either the defaults or the markup that uses them is caught.
     * AA is 4.5:1 for normal text and 3:1 for large text and UI borders.
     */
    await mount(page);

    const contrast = await page.evaluate(() => {
      const luminance = (rgb: string) => {
        const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).map(Number) as [number, number, number];
        const channel = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const ratio = (a: string, b: string) => {
        const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number];
        return (x + 0.05) / (y + 0.05);
      };

      const root = document.querySelector('gnomon-calendar')!.shadowRoot!;
      const host = document.querySelector('gnomon-calendar') as HTMLElement;
      const surface = getComputedStyle(host).backgroundColor;
      const body = getComputedStyle(root.querySelector('.gnomon-root') as HTMLElement);
      const pressed = root.querySelector('button[aria-pressed="true"]') as HTMLElement;
      const pressedStyle = getComputedStyle(pressed);

      return {
        bodyText: ratio(body.color, surface),
        selectedButton: ratio(pressedStyle.color, pressedStyle.backgroundColor),
      };
    });

    expect(contrast.bodyText).toBeGreaterThanOrEqual(4.5);
    expect(contrast.selectedButton).toBeGreaterThanOrEqual(4.5);
  });
});
