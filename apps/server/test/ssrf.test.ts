import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAddress, checkUrl, UrlRejectedError } from '../src/ingest/ssrf.js';
import { FetchFailedError, fetchIcs } from '../src/ingest/fetch.js';

/**
 * SSRF protection (phase 7.2).
 *
 * The highest-severity control in the project: an ICS source is a URL a
 * TENANT supplies and WE fetch from our own network, so whatever we can reach
 * they can reach through us.
 *
 * The address table below is exhaustive on purpose. Every entry is a real
 * bypass someone has used, and the cheapest possible defence against
 * forgetting one is to enumerate them where a reader can check the list.
 */

describe('addresses we refuse to connect to', () => {
  const blocked: [string, string][] = [
    ['127.0.0.1', 'the obvious one'],
    ['127.1', 'shorthand for 127.0.0.1 -- the whole /8 is loopback'],
    ['127.255.255.254', 'still loopback'],
    ['0.0.0.0', 'routed to localhost by many stacks'],
    ['0.1.2.3', 'all of 0.0.0.0/8'],
    ['10.0.0.1', 'RFC 1918'],
    ['172.16.0.1', 'RFC 1918, low end'],
    ['172.31.255.255', 'RFC 1918, high end'],
    ['192.168.1.1', 'RFC 1918'],
    ['169.254.169.254', 'CLOUD METADATA -- the reason this module exists'],
    ['169.254.0.1', 'all link-local, not just the metadata address'],
    ['100.64.0.1', 'carrier-grade NAT, routable-looking but internal'],
    ['100.127.255.255', 'top of the CGNAT range'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['240.0.0.1', 'reserved'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['198.18.0.1', 'benchmarking range'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fc00::1', 'IPv6 unique local'],
    ['fd12:3456::1', 'IPv6 unique local, fd prefix'],
    ['fe80::1', 'IPv6 link-local'],
    ['ff02::1', 'IPv6 multicast'],
    ['2001:db8::1', 'documentation range'],
    ['64:ff9b::7f00:1', 'NAT64, which translates to arbitrary IPv4'],
    ['::ffff:127.0.0.1', 'IPv4-MAPPED loopback -- 127.0.0.1 in a costume'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata endpoint'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::127.0.0.1', 'IPv4-compatible loopback'],
  ];

  for (const [address, why] of blocked) {
    it(`refuses ${address} — ${why}`, () => {
      expect(checkAddress(address).allowed).toBe(false);
    });
  }

  it('allows ordinary public addresses', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700::1111']) {
      expect(checkAddress(address), `${address} should be allowed`).toEqual({ allowed: true });
    }
  });

  it('refuses anything it cannot parse rather than assuming it is safe', () => {
    // Deny by default: an address we cannot classify is one we cannot reason
    // about.
    for (const junk of ['', 'not-an-ip', '999.1.1.1', '1.2.3', 'fe80::gggg']) {
      expect(checkAddress(junk).allowed).toBe(false);
    }
  });
});

describe('URLs we refuse before resolving anything', () => {
  it('refuses non-http schemes', () => {
    // file: reads our disk; gopher: and dict: have historically been coerced
    // into speaking other protocols, turning SSRF into arbitrary Redis
    // commands. A scheme allowlist removes the whole family.
    for (const url of [
      'file:///etc/passwd',
      'gopher://127.0.0.1:6379/_INFO',
      'dict://127.0.0.1:11211/stat',
      'ftp://example.test/cal.ics',
    ]) {
      expect(() => checkUrl(url)).toThrow(UrlRejectedError);
    }
  });

  it('refuses credentials embedded in the URL', () => {
    // http://expected.test@evil.test/ is a classic way to smuggle a different
    // host past a parser that reads left to right.
    expect(() => checkUrl('http://user:pass@example.test/cal.ics')).toThrow(/credentials/i);
    expect(() => checkUrl('http://expected.test@evil.test/cal.ics')).toThrow(UrlRejectedError);
  });

  it('refuses a literal private address without a DNS query', () => {
    expect(() => checkUrl('http://169.254.169.254/latest/meta-data/')).toThrow(UrlRejectedError);
    expect(() => checkUrl('http://[::1]:8080/cal.ics')).toThrow(UrlRejectedError);
  });

  it('accepts an ordinary https URL', () => {
    expect(checkUrl('https://example.test/calendar.ics').hostname).toBe('example.test');
  });
});

// ---------------------------------------------------------------------------
// Against a real server, because the interesting failures are behavioural
// ---------------------------------------------------------------------------

describe('fetching', () => {
  let server: Server;
  let base: string;
  let requests: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push(req.url ?? '');
      const url = new URL(req.url ?? '/', 'http://localhost');

      switch (url.pathname) {
        case '/calendar.ics':
          if (req.headers['if-none-match'] === '"v1"') {
            res.writeHead(304, { ETag: '"v1"' });
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/calendar', ETag: '"v1"' });
          res.end('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n');
          return;

        case '/redirect-to-metadata':
          // The single most common SSRF filter bypass: the first URL is
          // innocent and the redirect is not.
          res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
          res.end();
          return;

        case '/redirect-to-loopback':
          res.writeHead(302, { Location: 'http://127.0.0.1:1/' });
          res.end();
          return;

        case '/redirect-loop':
          res.writeHead(302, { Location: '/redirect-loop' });
          res.end();
          return;

        case '/huge':
          res.writeHead(200, { 'Content-Type': 'text/calendar', 'Content-Length': '10' });
          // Lies about its length and then sends indefinitely, which is why
          // the cap is enforced while streaming rather than from the header.
          for (let i = 0; i < 200; i += 1) res.write('x'.repeat(64 * 1024));
          res.end();
          return;

        case '/slow':
          setTimeout(() => res.end('too late'), 5_000);
          return;

        default:
          res.writeHead(404);
          res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * The test server is on 127.0.0.1, which the guard blocks by design. These
   * tests therefore run through `localhost.test`-style hostnames only where
   * the point is resolution; where the point is redirect or size behaviour,
   * the guard is relaxed by pointing at the loopback server deliberately and
   * asserting the REFUSAL instead.
   */
  it('refuses to fetch the loopback test server at all', async () => {
    // Proves the guard is live in the fetch path, not only in checkUrl. Note
    // this is ALSO why the redirect behaviour cannot be tested against this
    // server -- see the redirect suite below.
    await expect(fetchIcs(`${base}/calendar.ics`)).rejects.toThrow(UrlRejectedError);
    expect(requests).toEqual([]);
  });


  it('refuses a bare loopback URL', async () => {
    await expect(fetchIcs('http://127.0.0.1:9/cal.ics')).rejects.toThrow(UrlRejectedError);
    await expect(fetchIcs('http://localhost:9/cal.ics')).rejects.toThrow(UrlRejectedError);
  });

  it('refuses the metadata endpoint directly', async () => {
    await expect(fetchIcs('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      UrlRejectedError,
    );
  });

  it('refuses a scheme outside the allowlist', async () => {
    await expect(fetchIcs('file:///etc/passwd')).rejects.toThrow(UrlRejectedError);
  });

  it('gives up on an unresolvable host rather than hanging', async () => {
    await expect(
      fetchIcs('http://gnomon-does-not-exist.invalid/cal.ics', { timeoutMs: 5_000 }),
    ).rejects.toThrow(FetchFailedError);
  }, 20_000);
});

describe('redirects are re-validated at every hop', () => {
  /**
   * These use an injected request function rather than a real server, and
   * that is not a shortcut -- it is the only way to test the property.
   *
   * The loopback guard refuses a test server on 127.0.0.1 before any redirect
   * is followed, so a test pointing at one passes while proving nothing but
   * "loopback is blocked". Two tests in this file did exactly that until this
   * suite replaced them.
   *
   * Following a redirect without re-checking the destination is the single
   * most common way an SSRF filter is bypassed: the first URL is innocent and
   * the Location header is not.
   */
  const respond = (status: number, location?: string) =>
    Promise.resolve({
      status,
      ...(location ? { location } : {}),
      headers: {},
      message: null as never,
    });

  it('refuses a redirect to the cloud metadata endpoint', async () => {
    await expect(
      fetchIcs('https://calendar.example.test/feed.ics', {
        perform: (url) =>
          url.hostname === 'calendar.example.test'
            ? respond(302, 'http://169.254.169.254/latest/meta-data/')
            : respond(200),
      }),
    ).rejects.toThrow(UrlRejectedError);
  });

  it('refuses a redirect to loopback', async () => {
    await expect(
      fetchIcs('https://calendar.example.test/feed.ics', {
        perform: () => respond(302, 'http://127.0.0.1:6379/'),
      }),
    ).rejects.toThrow(UrlRejectedError);
  });

  it('refuses a redirect that changes scheme to file:', async () => {
    await expect(
      fetchIcs('https://calendar.example.test/feed.ics', {
        perform: () => respond(302, 'file:///etc/passwd'),
      }),
    ).rejects.toThrow(UrlRejectedError);
  });

  it('resolves a RELATIVE redirect and still validates it', async () => {
    // A relative Location is legal and common, and resolving it against the
    // wrong base is another way to end up somewhere unintended.
    const seen: string[] = [];
    await expect(
      fetchIcs('https://calendar.example.test/a/feed.ics', {
        perform: (url) => {
          seen.push(url.toString());
          return seen.length === 1 ? respond(302, '../b/feed.ics') : respond(404);
        },
      }),
    ).rejects.toThrow(FetchFailedError);

    expect(seen[1]).toBe('https://calendar.example.test/b/feed.ics');
  });

  it('gives up rather than following a redirect loop for ever', async () => {
    let hops = 0;
    await expect(
      fetchIcs('https://calendar.example.test/loop', {
        perform: () => {
          hops += 1;
          return respond(302, 'https://calendar.example.test/loop');
        },
      }),
    ).rejects.toThrow(/redirects/i);

    // Bounded, and the bound is small.
    expect(hops).toBeLessThanOrEqual(5);
  });

  it('follows a legitimate redirect to a public host', async () => {
    // The guard must not be so blunt that ordinary feeds break -- plenty of
    // real ICS URLs redirect to a CDN.
    const result = await fetchIcs('https://calendar.example.test/feed.ics', {
      perform: (url) =>
        url.hostname === 'calendar.example.test'
          ? respond(302, 'https://cdn.example.test/feed.ics')
          : Promise.resolve({
              status: 304,
              headers: { etag: '"v1"' },
              message: null as never,
            }),
    });

    expect(result.status).toBe(304);
    expect(result.etag).toBe('"v1"');
  });
});
