import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono, Env } from 'hono';

/**
 * Serving the embed assets (phase 4.5, 4.7).
 *
 *   GET /embed.js          the loader -- the file integrators paste
 *   GET /embed/<file>.js   the component bundle and its chunks
 *   GET /embed/frame       the iframe fallback page
 *
 * These are the only unauthenticated routes that return anything but an
 * error. They contain no tenant data: the bundle is the same bytes for
 * everyone, and the frame page renders nothing until a token is posted in.
 */

const LOADER_DIST = fileURLToPath(new URL('../../../../packages/loader/dist', import.meta.url));
const EMBED_DIST = fileURLToPath(new URL('../../../../packages/embed/dist', import.meta.url));

/**
 * Vite emits hashed chunk names, so the filename cannot be an allowlist.
 * It CAN be constrained: a single path segment, no separators, no dots
 * beyond the extension. Traversal is refused by shape rather than by
 * normalising and hoping.
 */
const SAFE_ASSET = /^[A-Za-z0-9_-]+\.(js|css|map)$/;

const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
/** The unhashed entry points must revalidate, or a deploy never reaches anyone. */
const CACHE_ENTRY = 'public, max-age=300, must-revalidate';

// Generic over the env so the OpenAPIHono instance can pass itself in;
// these routes touch neither variables nor the OpenAPI registry.
export function registerEmbedRoutes<E extends Env>(app: Hono<E>): void {
  app.get('/embed.js', (c) => {
    const body = readAsset(LOADER_DIST, 'embed.js');
    if (!body) return c.text('// gnomon: loader not built', 503, jsHeaders(CACHE_ENTRY));
    return c.body(body, 200, jsHeaders(CACHE_ENTRY));
  });

  app.get('/embed/frame', (c) => c.html(framePage(), 200, frameHeaders()));

  // Generated rather than bundled: it is four rules, and serving it as a file
  // keeps the frame page free of inline styles so it loads under its own
  // strict policy.
  app.get('/embed/frame.css', (c) =>
    c.body(
      'html,body{margin:0;height:100%;}' +
        'body{font:14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;}' +
        '#root{height:100%;padding:0;}',
      200,
      { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': CACHE_ENTRY },
    ),
  );

  app.get('/embed/:file', (c) => {
    const file = c.req.param('file');
    if (!SAFE_ASSET.test(file)) return c.text('not found', 404);

    const body = readAsset(EMBED_DIST, file);
    if (!body) return c.text('not found', 404);

    // Hashed chunks are immutable; the stable entry names are not.
    const hashed = /-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(file);
    return c.body(body, 200, jsHeaders(hashed ? CACHE_IMMUTABLE : CACHE_ENTRY, file));
  });
}

function readAsset(dir: string, file: string): string | null {
  const path = join(dir, file);
  // join() has already normalised, so a traversal attempt would land outside
  // the directory -- refuse anything that did.
  if (!path.startsWith(dir) || !existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function jsHeaders(cacheControl: string, file = 'x.js'): Record<string, string> {
  return {
    'Content-Type': file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
    'Cache-Control': cacheControl,
    // The loader is fetched cross-origin from the host's page.
    'Access-Control-Allow-Origin': '*',
  };
}

/**
 * The frame page is deliberately strict about itself.
 *
 * `frame-ancestors *` is the one permissive directive, and it has to be: this
 * page exists to be embedded, and we do not know which portal is embedding
 * until a token arrives -- by which point the page has already loaded.
 * Restricting it per tenant would require knowing the tenant before the
 * request, which the design (ADR-0004) deliberately does not allow.
 *
 * That is acceptable because the page is inert without a token, and the token
 * can only come from the embedder via postMessage. An attacker who frames
 * this page gets an empty rectangle.
 */
function frameHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      // The component uses adoptedStyleSheets, which is not subject to
      // style-src -- but the renderer may still inject a <style> element.
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      'frame-ancestors *',
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
    'Cache-Control': CACHE_ENTRY,
    'Referrer-Policy': 'no-referrer',
  };
}

/**
 * No inline script and no inline style, so this page loads under its own
 * `script-src 'self'` policy. An inline bootstrap would have forced
 * `unsafe-inline`, which is the thing the fallback exists to avoid.
 */
function framePage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Calendar</title>
    <link rel="stylesheet" href="/embed/frame.css" />
  </head>
  <body>
    <div id="root">Loading calendar…</div>
    <script type="module" src="/embed/gnomon-frame.js"></script>
  </body>
</html>
`;
}
