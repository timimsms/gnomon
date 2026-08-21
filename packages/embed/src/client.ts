import type { EventOccurrence } from '@gnomon/core';

/**
 * The API client, and the token lifecycle around it.
 *
 * Gnomon issues no tokens (ADR-0004): the host portal's backend mints one and
 * the embed fetches it from an endpoint on the host's own domain. Everything
 * awkward about this component lives here rather than in the element.
 */

export interface TokenProvider {
  /** Returns a usable token, minting or refreshing as needed. */
  get(): Promise<string>;
  /** Discards any cached token. Called when the server rejects one. */
  invalidate(): void;
}

export class TokenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    // Passed through rather than shadowed: Error already defines `cause`, and
    // redeclaring it hides the original from anything that inspects it.
    super(message, options);
    this.name = 'TokenError';
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A fixed token. Useful for demos and tests; not for production embeds. */
export function staticToken(token: string): TokenProvider {
  return { get: () => Promise.resolve(token), invalidate: () => {} };
}

/**
 * Fetches tokens from an endpoint on the host's domain.
 *
 * Tokens are short-lived by design -- five minutes is the documented default
 * and Gnomon refuses anything over fifteen -- so a session of any length will
 * cross an expiry. Refreshing has to be invisible.
 */
export function endpointToken(
  endpoint: string,
  options: { fetch?: typeof globalThis.fetch; now?: () => number } = {},
): TokenProvider {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => Date.now());

  let cached: { token: string; refreshAfter: number } | null = null;
  // Concurrent callers share one request. Without this, mounting three
  // calendars on a page mints three tokens on load and three more at every
  // refresh.
  let inFlight: Promise<string> | null = null;

  async function mint(): Promise<string> {
    let response: Response;
    try {
      // `credentials: same-origin` because the endpoint is the host's own and
      // authenticates the user with their existing session cookie. Without
      // it the host cannot tell who is asking.
      response = await doFetch(endpoint, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      throw new TokenError(`Could not reach the token endpoint at ${endpoint}.`, { cause: error });
    }

    if (!response.ok) {
      throw new TokenError(`Token endpoint returned ${response.status}.`);
    }

    const body = (await response.json().catch(() => null)) as { token?: string } | null;
    if (!body?.token) {
      throw new TokenError('Token endpoint did not return a { token } payload.');
    }

    cached = { token: body.token, refreshAfter: refreshDeadline(body.token, now()) };
    return body.token;
  }

  return {
    async get() {
      if (cached && now() < cached.refreshAfter) return cached.token;
      inFlight ??= mint().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    invalidate() {
      cached = null;
    },
  };
}

/**
 * When to refresh, from the token's own `exp`.
 *
 * The JWT is decoded WITHOUT verification, which is correct here: the client
 * is not an authority on the token's validity and cannot be. It only needs to
 * know roughly when to ask for another one, and getting that wrong is a
 * refetch, not a security event.
 *
 * Refreshes at 75% of the lifetime so a slow network still resolves before
 * expiry. A token we cannot parse is treated as expiring shortly, which
 * degrades to "refresh often" rather than "use a dead token forever".
 */
function refreshDeadline(token: string, issuedAtMs: number): number {
  const FALLBACK_MS = 60_000;
  const payload = token.split('.')[1];
  if (!payload) return issuedAtMs + FALLBACK_MS;

  try {
    const json = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { exp?: number };
    if (typeof json.exp !== 'number') return issuedAtMs + FALLBACK_MS;

    const remaining = json.exp * 1000 - issuedAtMs;
    // An already-expired token still gets one attempt rather than a
    // busy-loop of refreshes.
    return remaining <= 0 ? issuedAtMs + 5_000 : issuedAtMs + remaining * 0.75;
  } catch {
    return issuedAtMs + FALLBACK_MS;
  }
}

export interface FetchEventsParams {
  from: string;
  to: string;
  tz: string;
  calendarIds?: readonly string[];
  signal?: AbortSignal;
}

export class CalendarClient {
  readonly #baseUrl: string;
  readonly #tokens: TokenProvider;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: {
    baseUrl: string;
    tokens: TokenProvider;
    fetch?: typeof globalThis.fetch;
  }) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#tokens = options.tokens;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async fetchEvents(params: FetchEventsParams): Promise<EventOccurrence[]> {
    const url = new URL(`${this.#baseUrl}/events`);
    url.searchParams.set('from', params.from);
    url.searchParams.set('to', params.to);
    url.searchParams.set('tz', params.tz);
    if (params.calendarIds?.length) {
      url.searchParams.set('calendarId', params.calendarIds.join(','));
    }

    const body = await this.#request(url, params.signal);
    return (body as { occurrences: EventOccurrence[] }).occurrences ?? [];
  }

  async fetchCalendars(signal?: AbortSignal) {
    const body = await this.#request(new URL(`${this.#baseUrl}/calendars`), signal);
    return (body as { calendars: { id: string; name: string; timeZone: string }[] }).calendars ?? [];
  }

  async #request(url: URL, signal?: AbortSignal): Promise<unknown> {
    const send = async (token: string) =>
      this.#fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        ...(signal ? { signal } : {}),
      });

    let response = await send(await this.#tokens.get());

    // A 401 means our token expired between mint and use -- clocks drift and
    // tabs sleep. Retry ONCE with a fresh one; retrying further would turn a
    // genuine auth failure into a request loop against the host's endpoint.
    if (response.status === 401) {
      this.#tokens.invalidate();
      response = await send(await this.#tokens.get());
    }

    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as
        | { error?: string; message?: string }
        | null;
      throw new ApiError(
        response.status,
        problem?.error ?? 'request_failed',
        problem?.message ?? `Gnomon returned ${response.status}.`,
      );
    }

    return response.json();
  }
}
