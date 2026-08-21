/**
 * The hostile-host scenarios (phase 4.8).
 *
 * Each page is a portal that a real integrator might plausibly have built,
 * and each one is hostile in a *specific*, named way. The point is not to be
 * adversarial for its own sake -- it is that every one of these is something
 * a normal engineering team does for normal reasons, without ever thinking
 * about an embedded calendar.
 */

export interface PageOptions {
  /** Gnomon's origin, which is a different origin from this portal. */
  gnomonOrigin: string;
  calendars: string;
  /** Forced iframe/inline, or `auto` to let the loader decide. */
  mode?: 'auto' | 'inline' | 'iframe';
  tz?: string;
}

function snippet(options: PageOptions, extra: Record<string, string> = {}): string {
  const attrs: Record<string, string> = {
    'data-gnomon-api': options.gnomonOrigin,
    'data-gnomon-token-endpoint': '/api/gnomon-token',
    'data-gnomon-calendars': options.calendars,
    'data-gnomon-date': '2026-03-01',
    'data-gnomon-tz': options.tz ?? 'America/New_York',
    ...(options.mode && options.mode !== 'auto' ? { 'data-gnomon-mode': options.mode } : {}),
    ...extra,
  };

  const rendered = Object.entries(attrs)
    .map(([name, value]) => `\n          ${name}="${value}"`)
    .join('');

  return `<script src="${options.gnomonOrigin}/embed.js"${rendered}
          defer></script>`;
}

function page(title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
${head}
  </head>
  <body>
    <h1>${title}</h1>
${body}
  </body>
</html>
`;
}

/** The baseline: a plain portal doing nothing unusual. */
export function plainPage(options: PageOptions): string {
  return page('Resident portal', '', `    ${snippet(options)}`);
}

/**
 * A CSS reset that targets `*`, plus a design system that assumes it owns
 * every element on the page. Extremely common, and none of it is written
 * with an embedded widget in mind.
 */
export function hostileCssPage(options: PageOptions): string {
  return page(
    'Portal with a global reset',
    `    <style>
      * { margin: 0 !important; padding: 0 !important; box-sizing: border-box !important;
          font-family: "Comic Sans MS", cursive !important; color: #cc0000 !important;
          text-transform: uppercase !important; letter-spacing: 3px !important; }
      div { border: 5px dotted #ff00ff !important; }
      button { background: #cc0000 !important; border-radius: 50% !important; }
      table { border-collapse: separate !important; }
    </style>`,
    `    ${snippet(options)}`,
  );
}

/**
 * jQuery, plus a page that has ALREADY loaded a different calendar library.
 *
 * The second is the sharper test: another calendar's global CSS is exactly
 * the kind of thing that collides, and a portal that is migrating from one
 * calendar to another will genuinely have both on the page at once.
 */
export function crowdedPage(options: PageOptions): string {
  return page(
    'Portal with jQuery and another calendar',
    `    <script>
      // A deliberately old-fashioned jQuery stand-in, including the global
      // aliases real pages have.
      window.jQuery = window.$ = function (selector) {
        return { selector: selector, length: 0, on: function () { return this; } };
      };
      window.jQuery.fn = { calendar: function () { return this; } };
    </script>
    <style>
      /* Another calendar library's global stylesheet. Class names of this
         shape are not hypothetical -- ".fc" and ".ec" are exactly what our
         two renderers use. */
      .fc, .ec { display: none !important; }
      .fc-event, .ec-event { visibility: hidden !important; }
      .calendar, .calendar * { color: transparent !important; }
    </style>`,
    `    <div class="calendar">A pre-existing calendar widget lives here.</div>
    ${snippet(options)}`,
  );
}

/** Two embeds, different calendars, different timezones, on one page. */
export function twoEmbedsPage(options: PageOptions): string {
  const [first = '', second = ''] = options.calendars.split(',');
  return page(
    'Portal with two calendars',
    '',
    `    <section id="first">
      ${snippet({ ...options, calendars: first, tz: 'America/New_York' }, { 'data-gnomon-target': '#first-slot' })}
      <div id="first-slot"></div>
    </section>
    <section id="second">
      ${snippet({ ...options, calendars: second || first, tz: 'Asia/Tokyo' }, { 'data-gnomon-target': '#second-slot' })}
      <div id="second-slot"></div>
    </section>`,
  );
}

/**
 * A portal whose own timezone is nowhere near the calendar's.
 *
 * The browser's timezone must not decide which day an event lands on -- that
 * is the `tz` parameter's job, resolved server-side (ADR-0005).
 */
export function farTimezonePage(options: PageOptions): string {
  return page('Portal in another timezone', '', `    ${snippet({ ...options, tz: 'Pacific/Kiritimati' })}`);
}

/** Forces the iframe path, so the fallback is exercised on its own terms. */
export function iframePage(options: PageOptions): string {
  return page('Portal using the iframe fallback', '', `    ${snippet({ ...options, mode: 'iframe' })}`);
}

/**
 * Strict CSP, expressed as a real header rather than a meta tag.
 *
 * `script-src 'self' <gnomon>` is the realistic strict policy: a portal that
 * has decided to allow our script but nothing inline. Note there is NO
 * `'unsafe-inline'` anywhere, including for styles.
 */
export function strictCspPage(options: PageOptions): string {
  return page('Portal with a strict CSP', '', `    ${snippet(options)}`);
}

export function strictCspHeader(gnomonOrigin: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' ${gnomonOrigin}`,
    `connect-src 'self' ${gnomonOrigin}`,
    `frame-src ${gnomonOrigin}`,
    // Deliberately no 'unsafe-inline'. If the component needs it, we want to
    // find that out here rather than from an integrator.
    "style-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
  ].join('; ');
}
