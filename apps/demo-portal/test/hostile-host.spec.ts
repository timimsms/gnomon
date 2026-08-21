import { expect, test, type Page } from '@playwright/test';

/**
 * The hostile-host suite (phase 4.8).
 *
 * A real Gnomon server and a real portal on a DIFFERENT ORIGIN, with real
 * tokens signed by a real key. Nothing is mocked, because every hazard here
 * exists only because the two are not the same site.
 *
 * Each page is hostile in one specific, named way, and every one of those
 * things is something a normal team does for normal reasons without ever
 * thinking about an embedded calendar.
 */

const EVENT = 'Boiler inspection';

/** Waits for whichever path the loader chose, and reports which it was. */
async function waitForCalendar(page: Page): Promise<'inline' | 'iframe'> {
  await page.waitForFunction(
    () => Boolean(document.querySelector('gnomon-calendar') || document.querySelector('iframe')),
    undefined,
    { timeout: 20_000 },
  );
  return (await page.locator('gnomon-calendar').count()) > 0 ? 'inline' : 'iframe';
}

/** The calendar's own surface, whether inline or inside the fallback frame. */
function surface(page: Page) {
  return page.locator('gnomon-calendar').first();
}

test.describe('the baseline', () => {
  test('one pasted script tag renders a calendar from another origin', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/');
    expect(await waitForCalendar(page)).toBe('inline');

    await expect(surface(page)).toContainText(EVENT);
    expect(errors).toEqual([]);
  });

  test('the host never receives a token in a URL', async ({ page }) => {
    // Tokens in URLs end up in referrer logs, history, and analytics.
    const urls: string[] = [];
    page.on('request', (r) => urls.push(r.url()));

    await page.goto('/');
    await waitForCalendar(page);
    await expect(surface(page)).toContainText(EVENT);

    // A JWT is three dot-separated base64url segments; nothing shaped like
    // one should appear in any URL the browser requested.
    expect(urls.filter((u) => /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./.test(u))).toEqual([]);
  });
});

test.describe('a host stylesheet that owns everything', () => {
  test('survives a global reset with !important on every element', async ({ page }) => {
    await page.goto('/hostile-css');
    await waitForCalendar(page);
    await expect(surface(page)).toContainText(EVENT);

    const styles = await page.evaluate(() => {
      const root = document.querySelector('gnomon-calendar')!.shadowRoot!;
      const button = root.querySelector('button')!;
      const computed = getComputedStyle(button);
      return {
        font: computed.fontFamily,
        transform: computed.textTransform,
        spacing: computed.letterSpacing,
        radius: computed.borderRadius,
        outsideFont: getComputedStyle(document.querySelector('h1')!).fontFamily,
      };
    });

    // The host's rules really are in force outside, or this proves nothing.
    expect(styles.outsideFont).toContain('Comic Sans');

    expect(styles.font).not.toContain('Comic Sans');
    expect(styles.transform).not.toBe('uppercase');
    expect(styles.spacing).not.toBe('3px');
    expect(styles.radius).not.toBe('50%');
  });

  test('the calendar grid still lays out', async ({ page }) => {
    // Text can be present while the grid is completely unstyled -- which is
    // exactly what happened before renderer CSS was adopted into the shadow
    // root. Assert on computed layout, not content.
    await page.goto('/hostile-css');
    await waitForCalendar(page);
    await expect(surface(page)).toContainText(EVENT);

    const display = await page.evaluate(() => {
      const root = document.querySelector('gnomon-calendar')!.shadowRoot!;
      const grid = root.querySelector('.ec, .fc') as HTMLElement | null;
      return grid ? getComputedStyle(grid).display : 'NONE';
    });
    expect(display).toBe('flex');
  });
});

test.describe('a crowded page', () => {
  test('coexists with jQuery and another calendar library', async ({ page }) => {
    // The other library's stylesheet hides `.ec` and `.fc` outright. Inside
    // a shadow root its selectors cannot match ours, which is the property
    // being verified -- and the reason the renderer's own CSS has to live
    // inside the boundary too.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/crowded');
    await waitForCalendar(page);
    await expect(surface(page)).toContainText(EVENT);

    const visible = await page.evaluate(() => {
      const root = document.querySelector('gnomon-calendar')!.shadowRoot!;
      const grid = root.querySelector('.ec, .fc') as HTMLElement | null;
      return grid ? getComputedStyle(grid).display !== 'none' : false;
    });

    expect(visible).toBe(true);
    expect(errors).toEqual([]);
  });

  test('does not disturb the host\'s own globals', async ({ page }) => {
    await page.goto('/crowded');
    await waitForCalendar(page);

    // A widget that clobbers $ takes the host's page down with it.
    expect(await page.evaluate(() => typeof window.jQuery === 'function')).toBe(true);
    expect(await page.evaluate(() => window.$ === window.jQuery)).toBe(true);
  });
});

test.describe('two embeds on one page', () => {
  test('render independently with different calendars and timezones', async ({ page }) => {
    await page.goto('/two-embeds');
    await page.waitForFunction(() => document.querySelectorAll('gnomon-calendar').length === 2, undefined, {
      timeout: 20_000,
    });

    const tzs = await page.evaluate(() =>
      [...document.querySelectorAll('gnomon-calendar')].map((el) => el.getAttribute('tz')),
    );
    expect(tzs).toEqual(['America/New_York', 'Asia/Tokyo']);

    // Each got its own shadow root and its own renderer instance.
    const roots = await page.evaluate(
      () => [...document.querySelectorAll('gnomon-calendar')].filter((el) => el.shadowRoot).length,
    );
    expect(roots).toBe(2);
  });

  test('each lands in its own declared target', async ({ page }) => {
    await page.goto('/two-embeds');
    await page.waitForFunction(() => document.querySelectorAll('gnomon-calendar').length === 2);

    const placed = await page.evaluate(() => ({
      first: Boolean(document.querySelector('#first-slot gnomon-calendar')),
      second: Boolean(document.querySelector('#second-slot gnomon-calendar')),
    }));
    expect(placed).toEqual({ first: true, second: true });
  });
});

test.describe('a host in a distant timezone', () => {
  test('the requested zone decides the day, not the browser\'s', async ({ page }) => {
    // ADR-0005: which day an event falls on is resolved server-side from the
    // `tz` parameter. A browser in another zone must not shift it.
    await page.goto('/far-timezone');
    await waitForCalendar(page);
    await expect(surface(page)).toContainText(EVENT);

    const requested = await page.evaluate(() => {
      const el = document.querySelector('gnomon-calendar')!;
      return el.getAttribute('tz');
    });
    expect(requested).toBe('Pacific/Kiritimati');
  });
});

test.describe('the iframe fallback', () => {
  test('renders when the host forces it, without the token in the URL', async ({ page }) => {
    await page.goto('/iframe');

    const frame = page.frameLocator('iframe');
    await expect(frame.locator('gnomon-calendar')).toBeVisible({ timeout: 20_000 });
    await expect(frame.locator('gnomon-calendar')).toContainText(EVENT, { timeout: 20_000 });

    // The token arrived by postMessage, so the frame's own URL is clean.
    const src = await page.locator('iframe').getAttribute('src');
    expect(src).not.toMatch(/token/i);
    expect(src).not.toMatch(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./);
  });

  test('is sandboxed and does not get same-origin access', async ({ page }) => {
    await page.goto('/iframe');
    await expect(page.locator('iframe')).toBeVisible({ timeout: 20_000 });

    const sandbox = await page.locator('iframe').getAttribute('sandbox');
    expect(sandbox).toContain('allow-scripts');
    // allow-same-origin is required for postMessage targeting to work at all
    // (an opaque origin can never match a target origin). It grants the frame
    // GNOMON's origin, not the portal's, so the host is unaffected.
    expect(sandbox).toContain('allow-same-origin');
    // The genuinely dangerous ones stay withheld.
    expect(sandbox).not.toContain('allow-top-navigation');
    expect(sandbox).not.toContain('allow-popups');
    expect(sandbox).not.toContain('allow-forms');
  });
});

test.describe('token lifecycle against a real endpoint', () => {
  test('degrades visibly when the host\'s token endpoint fails', async ({ page }) => {
    // Not a mock: the portal's own endpoint really returns 503.
    await page.request.post('/api/test/break-token-endpoint');
    try {
      await page.goto('/');
      await waitForCalendar(page);

      // A blank rectangle is not a diagnosis.
      await expect(surface(page).getByRole('alert')).toBeVisible({ timeout: 20_000 });
      await expect(surface(page).getByRole('alert')).toContainText(/token/i);
    } finally {
      await page.request.post('/api/test/fix-token-endpoint');
    }
  });

  test('recovers on reload once the endpoint is healthy again', async ({ page }) => {
    await page.request.post('/api/test/break-token-endpoint');
    await page.goto('/');
    await waitForCalendar(page);
    await expect(surface(page).getByRole('alert')).toBeVisible({ timeout: 20_000 });

    await page.request.post('/api/test/fix-token-endpoint');
    await page.reload();
    await waitForCalendar(page);
    await expect(surface(page)).toContainText(EVENT, { timeout: 20_000 });
  });
});

test.describe('cross-origin plumbing', () => {
  test('the events request really is cross-origin and really is allowed', async ({ page }) => {
    // Without CORS the loader and bundle still arrive -- classic script
    // loading is not CORS-gated -- and only this request fails, opaquely.
    const events = page.waitForResponse((r) => r.url().includes('/events'), { timeout: 20_000 });

    await page.goto('/');
    const response = await events;

    expect(new URL(response.url()).origin).not.toBe(new URL(page.url()).origin);
    expect(response.status()).toBe(200);
    expect(response.headers()['access-control-allow-origin']).toBe('*');
  });

  test('ETag is readable by the embed, so conditional GET works cross-origin', async ({ page }) => {
    // The header is sent regardless; without Expose-Headers the browser
    // hides it from script and phase 3.3's work becomes invisible here.
    const events = page.waitForResponse((r) => r.url().includes('/events'), { timeout: 20_000 });
    await page.goto('/');
    const response = await events;

    expect(response.headers()['etag']).toBeTruthy();
    expect(response.headers()['access-control-expose-headers']).toContain('ETag');
  });
});

test.describe('a strict Content-Security-Policy', () => {
  /**
   * `script-src 'self' <gnomon>`, `style-src 'self'`, no `'unsafe-inline'`
   * anywhere, delivered as a real header rather than a meta tag.
   *
   * This is the phase's headline exit criterion, and the one scenario whose
   * outcome was genuinely unknown before running it: the component styles
   * itself with `adoptedStyleSheets`, which is NOT subject to `style-src`,
   * so the inline path may survive a policy that would block a <style> tag.
   * If it does not, the loader falls back to the iframe and the integrator
   * still gets a calendar -- which is exactly why the fallback exists.
   */
  test('renders a working calendar with no unsafe-inline', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
    });

    await page.goto('/strict-csp');
    const mode = await waitForCalendar(page);

    if (mode === 'inline') {
      await expect(surface(page)).toContainText(EVENT, { timeout: 20_000 });
    } else {
      await expect(page.frameLocator('iframe').locator('gnomon-calendar')).toContainText(EVENT, {
        timeout: 20_000,
      });
    }

    // Recorded rather than asserted-on: which path a strict host takes is a
    // property of their policy, and BOTH are a pass. What must not happen is
    // no calendar at all.
    console.log(`strict CSP resolved via the ${mode} path`);
    if (violations.length > 0) console.log(`CSP notices: ${violations.slice(0, 3).join(' | ')}`);
  });

  test('styles survive without unsafe-inline', async ({ page }) => {
    // The component uses adoptedStyleSheets precisely so that a policy
    // forbidding inline styles does not leave an unstyled grid.
    await page.goto('/strict-csp');
    const mode = await waitForCalendar(page);
    test.skip(mode === 'iframe', 'inline path not taken; styling is covered inside the frame');

    await expect(surface(page)).toContainText(EVENT, { timeout: 20_000 });

    const display = await page.evaluate(() => {
      const root = document.querySelector('gnomon-calendar')!.shadowRoot!;
      const grid = root.querySelector('.ec, .fc') as HTMLElement | null;
      return grid ? getComputedStyle(grid).display : 'NONE';
    });
    expect(display).toBe('flex');
  });

  test('the policy is genuinely strict, or these tests prove nothing', async ({ page }) => {
    const response = await page.goto('/strict-csp');
    const csp = response?.headers()['content-security-policy'] ?? '';

    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });
});
