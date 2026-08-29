import { isIP } from 'node:net';

/**
 * SSRF protection for tenant-supplied URLs (phase 7.2).
 *
 * An ICS source is a URL a tenant hands us and we fetch from our own network.
 * That is a request forgery primitive by construction: whatever we can reach,
 * they can now reach through us -- cloud metadata endpoints, internal admin
 * panels, databases bound to localhost, anything on the private network that
 * assumed being unroutable was protection.
 *
 * THE CENTRAL RULE: validate the RESOLVED ADDRESS, never the hostname.
 *
 * A hostname check is not a control. `http://evil.test/` can resolve to
 * 127.0.0.1, and an attacker controls their own DNS. Blocklisting "localhost"
 * stops nobody who has read this far.
 *
 * The second rule follows from the first: validate at the moment of
 * CONNECTION, using the same resolution the connection uses. Resolving,
 * checking, and then letting the HTTP client resolve again leaves a window in
 * which the second answer differs from the first -- DNS rebinding, and it is
 * a real technique rather than a theoretical one.
 *
 * This module is the pure half: given an address, is it allowed? It has no
 * I/O so it can be tested exhaustively, which matters because the interesting
 * cases are all edge cases.
 */

export type BlockReason =
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'unique_local'
  | 'carrier_nat'
  | 'unspecified'
  | 'multicast'
  | 'reserved'
  | 'unparseable';

export interface AddressVerdict {
  allowed: boolean;
  reason?: BlockReason;
}

const ALLOWED = { allowed: true } as const;
const block = (reason: BlockReason): AddressVerdict => ({ allowed: false, reason });

/**
 * Decides whether we are willing to open a connection to an address.
 *
 * Deny-by-default in shape: anything unparseable is refused rather than
 * assumed harmless, because an address we cannot classify is one we cannot
 * reason about.
 */
export function checkAddress(address: string): AddressVerdict {
  const version = isIP(address);
  if (version === 4) return checkIPv4(address);
  if (version === 6) return checkIPv6(address);
  return block('unparseable');
}

function checkIPv4(address: string): AddressVerdict {
  const octets = address.split('.').map(Number);
  const [a, b] = octets as [number, number, number, number];

  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return block('unparseable');
  }

  // 0.0.0.0/8 -- "this network". 0.0.0.0 in particular is routed to localhost
  // by many stacks, which makes it a loopback bypass in disguise.
  if (a === 0) return block('unspecified');
  // 127.0.0.0/8 -- all of it, not just 127.0.0.1. 127.1 is the same host.
  if (a === 127) return block('loopback');
  // RFC 1918.
  if (a === 10) return block('private');
  if (a === 172 && b >= 16 && b <= 31) return block('private');
  if (a === 192 && b === 168) return block('private');
  // 169.254.0.0/16 -- link-local, and the reason this whole module exists:
  // 169.254.169.254 is the cloud metadata endpoint on AWS, GCP and Azure.
  if (a === 169 && b === 254) return block('link_local');
  // 100.64.0.0/10 -- carrier-grade NAT. Routable-looking, frequently internal.
  if (a === 100 && b >= 64 && b <= 127) return block('carrier_nat');
  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast.
  if (a >= 224 && a <= 239) return block('multicast');
  if (a >= 240) return block('reserved');
  // 192.0.0.0/24, 192.0.2.0/24, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24
  // -- IETF protocol assignments and documentation ranges. Never a real feed.
  if (a === 192 && b === 0) return block('reserved');
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return block('reserved');
  if (a === 203 && b === 0) return block('reserved');

  return ALLOWED;
}

function checkIPv6(address: string): AddressVerdict {
  const lower = address.toLowerCase().split('%')[0] ?? '';

  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible (::127.0.0.1) forms
  // reach IPv4 destinations through an IPv6 literal. Checking only the IPv6
  // ranges below would let 127.0.0.1 straight through in a different costume.
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped?.[1]) return checkIPv4(mapped[1]);

  if (lower === '::' ) return block('unspecified');
  if (lower === '::1') return block('loopback');

  const groups = expandIPv6(lower);
  if (!groups) return block('unparseable');

  const first = groups[0] ?? 0;

  // fc00::/7 -- unique local addresses, the IPv6 equivalent of RFC 1918.
  if ((first & 0xfe00) === 0xfc00) return block('unique_local');
  // fe80::/10 -- link-local.
  if ((first & 0xffc0) === 0xfe80) return block('link_local');
  // ff00::/8 -- multicast.
  if ((first & 0xff00) === 0xff00) return block('multicast');
  // 2001:db8::/32 -- documentation.
  if (first === 0x2001 && groups[1] === 0x0db8) return block('reserved');
  // 64:ff9b::/96 -- NAT64, which translates to arbitrary IPv4 including
  // private space, so it inherits IPv4's problems without its checks.
  if (first === 0x0064 && groups[1] === 0xff9b) return block('reserved');

  return ALLOWED;
}

/** Expands an IPv6 literal to eight 16-bit groups, or null if malformed. */
function expandIPv6(address: string): number[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;

  const parse = (part: string) =>
    part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16));

  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];

  if ([...head, ...tail].some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;

  const missing = 8 - head.length - tail.length;
  if (halves.length === 2) {
    if (missing < 0) return null;
    return [...head, ...Array<number>(missing).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

export class UrlRejectedError extends Error {
  constructor(
    readonly reason: BlockReason | 'scheme' | 'credentials' | 'port' | 'too_many_redirects',
    message: string,
  ) {
    super(message);
    this.name = 'UrlRejectedError';
  }
}

/**
 * Only http and https, and only the default ports plus explicit common ones.
 *
 * `file:` reads our disk. `gopher:` and `dict:` can be coerced into speaking
 * other protocols, which historically turned SSRF into arbitrary Redis
 * commands. A scheme allowlist is one line and removes the entire family.
 */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * Checks everything about a URL that does not require resolving it.
 *
 * Deliberately NOT a substitute for the address check -- it is the cheap
 * filter that runs first, and it exists to reject obvious nonsense before we
 * spend a DNS query on it.
 */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlRejectedError('unparseable', 'That is not a valid URL.');
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new UrlRejectedError('scheme', `Only http and https are supported, not ${url.protocol}`);
  }

  // Credentials in the URL would be sent to whatever it resolves to, and are
  // a common way to smuggle a different host past a naive parser
  // (http://expected.test@evil.test/).
  if (url.username || url.password) {
    throw new UrlRejectedError('credentials', 'Credentials in the URL are not supported.');
  }

  // A literal IP can be rejected here without any DNS at all. A hostname
  // still has to wait for resolution -- that check is the real one.
  if (isIP(url.hostname) !== 0) {
    const verdict = checkAddress(url.hostname);
    if (!verdict.allowed) {
      throw new UrlRejectedError(verdict.reason as BlockReason, `Refusing to fetch ${url.hostname}.`);
    }
  }

  // Bracketed IPv6 literals arrive with the brackets still attached.
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (bare !== url.hostname && isIP(bare) !== 0) {
    const verdict = checkAddress(bare);
    if (!verdict.allowed) {
      throw new UrlRejectedError(verdict.reason as BlockReason, `Refusing to fetch ${bare}.`);
    }
  }

  return url;
}
