import type { Env, MiddlewareHandler } from 'hono';

/**
 * CORS (phase 4.5).
 *
 * Gnomon is embedded into other people's portals by definition, so every
 * request that matters is cross-origin. Without this the entire product is
 * unusable from a browser: the loader and the bundle arrive fine -- classic
 * script loading is not CORS-gated -- and then the very first `fetch` for
 * events fails with an opaque network error. Found end to end, not by
 * reading the code, because every prior test called the API same-origin.
 *
 * `Access-Control-Allow-Origin: *` with NO credentials.
 *
 * That pairing is deliberate and is what makes the wildcard safe here.
 * Authorisation is a bearer token (ADR-0004), never a cookie, so there is no
 * ambient authority for another origin to ride on: a page that does not have
 * a token gets nothing, and a page that does have one was given it by the
 * host portal on purpose. CORS is not the security boundary for a
 * bearer-token API -- the token and RLS are -- and pretending otherwise by
 * echoing origins would add a maintenance burden that buys nothing.
 *
 * Setting `Allow-Credentials: true` alongside a wildcard is forbidden by the
 * spec anyway, and would be wrong even if it were not.
 */

/**
 * `ETag` must be EXPOSED or a cross-origin caller cannot read it, and the
 * conditional-GET work from phase 3.3 becomes invisible in exactly the
 * deployment it was built for. The response header is sent either way; the
 * browser simply hides it from script without this.
 */
const EXPOSED = ['ETag'].join(', ');

const ALLOWED_HEADERS = ['Authorization', 'Content-Type', 'If-None-Match'].join(', ');
const ALLOWED_METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'].join(', ');

export function cors<E extends Env>(): MiddlewareHandler<E> {
  return async (c, next) => {
    // No `Vary: Origin`: the response does not depend on the origin, so
    // advertising that it does would fragment every cache for no reason.
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Expose-Headers', EXPOSED);

    if (c.req.method === 'OPTIONS') {
      // The Authorization header is what makes these requests preflighted,
      // so this path runs before every single API call.
      c.header('Access-Control-Allow-Methods', ALLOWED_METHODS);
      c.header('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      c.header('Access-Control-Max-Age', '86400');
      return c.body(null, 204);
    }

    await next();
  };
}
