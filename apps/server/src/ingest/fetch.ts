import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { checkAddress, checkUrl, UrlRejectedError, type BlockReason } from './ssrf.js';

/**
 * Fetching a tenant-supplied ICS URL, safely (phase 7.2).
 *
 * Built on `node:http`/`node:https` rather than `fetch`, and that is a
 * deliberate trade of convenience for control. Three things this needs cannot
 * be done through global `fetch`:
 *
 *   1. A custom DNS `lookup`, which is what closes the rebinding window --
 *      see below. This is the whole reason for the choice.
 *   2. Manual redirect handling, so every hop is re-validated. `fetch`
 *      follows redirects internally, and a 302 to 169.254.169.254 defeats a
 *      check performed only on the original URL. This is the single most
 *      common way an SSRF filter is bypassed.
 *   3. Aborting mid-body on a size cap, rather than buffering a response that
 *      turns out to be a terabyte.
 */

/** ICS feeds are text. A large one is a few megabytes; 10 is generous. */
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;

export interface FetchResult {
  status: number;
  /** Absent on 304, which is the point of sending the validators. */
  body?: string;
  etag?: string;
  lastModified?: string;
}

export class FetchFailedError extends Error {
  constructor(
    readonly kind: 'network' | 'timeout' | 'too_large' | 'bad_status' | 'not_calendar',
    message: string,
  ) {
    super(message);
    this.name = 'FetchFailedError';
  }
}

export interface FetchOptions {
  /** Sent as If-None-Match, so an unchanged feed costs a 304. */
  etag?: string;
  /** Sent as If-Modified-Since, for servers that only honour that one. */
  lastModified?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * A DNS lookup that refuses to resolve to anywhere we will not talk to.
 *
 * THIS IS THE PART THAT MATTERS. Passing this as the `lookup` option means
 * the address the socket connects to is the address we validated -- there is
 * no second resolution between the check and the connection, so there is no
 * window for a DNS answer to change underneath us.
 *
 * The alternative -- resolve, validate, then hand the HOSTNAME to the HTTP
 * client -- looks equivalent and is not. The client resolves again, and an
 * attacker who controls the authoritative server can return a public address
 * first and a private one second. That is DNS rebinding, and it is why
 * "resolve then check" is not sufficient on its own.
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, options as never, (error, address, family) => {
    if (error) {
      (callback as (e: NodeJS.ErrnoException) => void)(error);
      return;
    }

    // `all: true` yields an array; the single-address form yields a string.
    const candidates = Array.isArray(address)
      ? (address as unknown as { address: string; family: number }[])
      : [{ address: address as unknown as string, family: family as number }];

    for (const candidate of candidates) {
      const verdict = checkAddress(candidate.address);
      if (!verdict.allowed) {
        // Refused at resolution, so no connection is ever attempted. The
        // reason travels in the error for the operator-facing last_error.
        const refusal = Object.assign(
          new Error(`${hostname} resolves to ${candidate.address} (${verdict.reason})`),
          { code: 'EGNOMONBLOCKED', reason: verdict.reason },
        );
        (callback as (e: NodeJS.ErrnoException) => void)(refusal);
        return;
      }
    }

    (callback as (e: null, a: string, f: number) => void)(
      null,
      candidates[0]!.address,
      candidates[0]!.family,
    );
  });
};

/**
 * Performs one request, with no redirect handling.
 *
 * Injectable so the redirect loop below can be tested honestly. The loopback
 * guard means a test server on 127.0.0.1 is refused before any redirect is
 * ever followed -- so a test that pointed at one would pass for entirely the
 * wrong reason, proving only that loopback is blocked. Substituting this
 * exercises the re-validation that actually matters.
 *
 * Production never passes it; the default is the real socket.
 */
export type PerformRequest = (
  url: URL,
  options: FetchOptions & { timeoutMs: number },
) => Promise<RawResponse>;

export async function fetchIcs(
  rawUrl: string,
  options: FetchOptions & { perform?: PerformRequest } = {},
): Promise<FetchResult> {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const perform = options.perform ?? once;

  let url = checkUrl(rawUrl);
  let redirects = 0;

  // Redirects are followed here, one hop at a time, so that checkUrl and the
  // guarded lookup run again for every destination.
  for (;;) {
    const response = await perform(url, { ...options, timeoutMs });

    if (response.status >= 300 && response.status < 400 && response.location) {
      if (redirects >= MAX_REDIRECTS) {
        throw new UrlRejectedError('too_many_redirects', `More than ${MAX_REDIRECTS} redirects.`);
      }
      redirects += 1;
      // Resolved against the current URL, because a relative Location is
      // legal and common.
      url = checkUrl(new URL(response.location, url).toString());
      continue;
    }

    if (response.status === 304) {
      return { status: 304, ...pickValidators(response.headers) };
    }

    if (response.status < 200 || response.status >= 300) {
      throw new FetchFailedError('bad_status', `Source returned ${response.status}.`);
    }

    const body = await readBody(response.message, maxBytes);
    return { status: response.status, body, ...pickValidators(response.headers) };
  }
}

export interface RawResponse {
  status: number;
  location?: string;
  headers: NodeJS.Dict<string | string[]>;
  message: IncomingMessage;
}

function once(url: URL, options: FetchOptions & { timeoutMs: number }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

    const req = send(
      url,
      {
        method: 'GET',
        lookup: guardedLookup,
        headers: {
          Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1',
          'User-Agent': 'Gnomon/0.1 (+https://github.com/timimsms/gnomon)',
          ...(options.etag ? { 'If-None-Match': options.etag } : {}),
          ...(options.lastModified ? { 'If-Modified-Since': options.lastModified } : {}),
        },
        // Redirects are handled by the caller, per hop.
        timeout: options.timeoutMs,
      },
      (message) => {
        resolve({
          status: message.statusCode ?? 0,
          ...(message.headers.location ? { location: message.headers.location } : {}),
          headers: message.headers,
          message,
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new FetchFailedError('timeout', `No response within ${options.timeoutMs}ms.`));
    });

    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EGNOMONBLOCKED') {
        const reason = (error as { reason?: BlockReason }).reason ?? 'unparseable';
        reject(new UrlRejectedError(reason, error.message));
        return;
      }
      reject(
        error instanceof FetchFailedError
          ? error
          : new FetchFailedError('network', error.message),
      );
    });

    req.end();
  });
}

/**
 * Reads the body, aborting as soon as the cap is exceeded.
 *
 * Checked while streaming rather than against Content-Length, which is
 * advertised by the server and therefore not evidence: a hostile source can
 * claim 1 KB and send indefinitely.
 */
function readBody(message: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    message.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        message.destroy();
        reject(new FetchFailedError('too_large', `Source exceeded ${maxBytes} bytes.`));
        return;
      }
      chunks.push(chunk);
    });

    message.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    message.on('error', (error) => reject(new FetchFailedError('network', error.message)));
  });
}

function pickValidators(headers: NodeJS.Dict<string | string[]>) {
  const etag = first(headers.etag);
  const lastModified = first(headers['last-modified']);
  return {
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
  };
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;
