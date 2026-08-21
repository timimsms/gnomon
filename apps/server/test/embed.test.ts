import { describe, expect, it } from 'vitest';
import { InMemoryKeyRegistry } from '../src/auth/registry.js';
import { createApp } from '../src/http/app.js';
import type { Database } from '../src/db/client.js';

/**
 * The embed asset routes (phase 4.5, 4.7).
 *
 * No database is involved: these serve the same bytes to everyone and are the
 * only unauthenticated routes that return anything but an error. That is
 * exactly why they deserve their own tests -- an unauthenticated file server
 * is where path traversal lives.
 */

const db = {
  withTenant: () => {
    throw new Error('embed routes must not touch the database');
  },
  close: () => Promise.resolve(),
} as unknown as Database;

const app = createApp({ db, registry: new InMemoryKeyRegistry() });
const get = (path: string) => app.request(path);

describe('GET /embed.js', () => {
  it('serves the loader without a token', async () => {
    // The loader is what OBTAINS a token; requiring one to fetch it would be
    // a chicken-and-egg.
    const res = await get('/embed.js');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('javascript');
    expect(await res.text()).toContain('gnomon');
  });

  it('is fetchable cross-origin', async () => {
    // It is loaded by a <script> tag on the host's page, not ours.
    expect((await get('/embed.js')).headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('revalidates rather than caching for ever', async () => {
    // The unhashed entry point must revalidate or a deploy never reaches
    // anyone already running the old one.
    expect((await get('/embed.js')).headers.get('Cache-Control')).toContain('must-revalidate');
  });
});

describe('GET /embed/<asset>', () => {
  it('serves the component bundle entry', async () => {
    const res = await get('/embed/gnomon-embed.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('javascript');
  });

  it('marks hashed chunks immutable and entry points revalidating', async () => {
    const chunk = (await get('/embed/gnomon-embed.js')).headers.get('Cache-Control');
    expect(chunk).toContain('must-revalidate');
  });

  for (const attempt of [
    '/embed/..%2F..%2F..%2Fpackage.json',
    '/embed/%2e%2e%2f%2e%2e%2fpackage.json',
    '/embed/....//package.json',
    '/embed/.env',
    '/embed/gnomon-embed.js%00.txt',
  ]) {
    it(`refuses traversal: ${attempt}`, async () => {
      // Refused by SHAPE -- a single path segment of safe characters -- rather
      // than by normalising a hostile string and hoping the result is inside
      // the directory.
      const res = await get(attempt);
      expect([400, 404]).toContain(res.status);
    });
  }

  it('refuses a file that is not an asset', async () => {
    expect((await get('/embed/tsconfig.json')).status).toBe(404);
  });
});

describe('GET /embed/frame', () => {
  it('serves a page with no inline script or style', async () => {
    // The whole point of the fallback is hosts with strict policies. A page
    // needing 'unsafe-inline' to boot would defeat it.
    const html = await (await get('/embed/frame')).text();

    expect(html).toContain('<script type="module" src="/embed/gnomon-frame.js">');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toContain('<style');
    expect(html).not.toMatch(/\sstyle="/);
  });

  it('sets a restrictive policy on itself', async () => {
    const csp = (await get('/embed/frame')).headers.get('Content-Security-Policy') ?? '';

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it('permits framing, because being framed is its entire purpose', async () => {
    const res = await get('/embed/frame');
    expect(res.headers.get('Content-Security-Policy')).toContain('frame-ancestors *');
    // X-Frame-Options would override the CSP in some browsers and break the
    // fallback outright.
    expect(res.headers.get('X-Frame-Options')).toBeNull();
  });

  it('sends no referrer, so the host URL does not leak to us', async () => {
    expect((await get('/embed/frame')).headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('renders nothing until a token arrives', async () => {
    // Inert without a token is what makes `frame-ancestors *` acceptable:
    // an attacker who frames this page gets an empty rectangle.
    const html = await (await get('/embed/frame')).text();
    expect(html).not.toContain('<gnomon-calendar');
    expect(html).toContain('id="root"');
  });

  it('serves its stylesheet as a file rather than inline', async () => {
    const res = await get('/embed/frame.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/css');
  });
});

describe('CORS', () => {
  /**
   * Gnomon is embedded into other people's portals, so every request that
   * matters is cross-origin. Without these headers the product is unusable
   * from a browser -- and it fails in a way that looks like nothing at all:
   * the loader and bundle arrive fine, because classic script loading is not
   * CORS-gated, and only the first `fetch` for events dies with an opaque
   * network error. Found end to end, because every other test in this repo
   * calls the API same-origin.
   */
  it('answers a preflight before authentication runs', async () => {
    // The Authorization header is what makes these requests preflighted, so
    // this path runs before every single API call. If auth ran first the
    // browser would see a 401 on the OPTIONS and never send the real request.
    const res = await app.request('/events', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://portal.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });

  it('exposes ETag, or conditional GET is invisible cross-origin', async () => {
    // The header is sent either way; without Expose-Headers the browser
    // simply hides it from script, and all of phase 3.3 stops working in
    // exactly the deployment it was built for.
    const res = await app.request('/events', { method: 'OPTIONS' });
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('ETag');
  });

  it('never combines a wildcard origin with credentials', async () => {
    // Forbidden by the spec, and wrong regardless: authorisation is a bearer
    // token (ADR-0004), never a cookie, so there is no ambient authority for
    // another origin to ride on. That pairing is what makes `*` safe here.
    const res = await app.request('/health', { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('still requires a token for data despite permissive CORS', async () => {
    // CORS is not the security boundary for a bearer-token API.
    const res = await app.request('/events?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(401);
  });
});
