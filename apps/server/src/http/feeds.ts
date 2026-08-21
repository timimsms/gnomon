import { createHash } from 'node:crypto';
import { serializeCalendar } from '@gnomon/core/ics';
import type { CalendarEvent } from '@gnomon/core';
import type { Context, Env, Hono } from 'hono';
import type { Database } from '../db/client.js';
import { fromEventRow, type EventRow } from '../db/events.js';
import { looksLikeFeedToken, resolveFeedToken } from '../feeds/tokens.js';

/**
 * The ICS feed endpoint (phase 5).
 *
 * The cheapest extensibility hook available (L10): a `webcal://` URL buys
 * Google, Apple and Outlook interop without writing a single line of OAuth.
 *
 * It is also the only surface that is genuinely public. Everything else
 * requires a host-minted JWT; this requires only the opaque token in the URL,
 * which is why rate limiting and revocation live here rather than being
 * deferred.
 */

/**
 * The feed's rolling window.
 *
 * Subscribers WILL notice where a feed ends, so this is documented rather
 * than tuned quietly. It is generous because recurring events are emitted as
 * RRULEs rather than expanded instances -- the client does its own expansion,
 * so the window only decides which stored events are included, not how much
 * work we do.
 */
const PAST_MONTHS = 6;
const FUTURE_MONTHS = 18;

/**
 * Feeds are polled hard and unconditionally. Apple Calendar's fastest
 * built-in interval is five minutes, and a subscriber with several devices
 * multiplies that. 60 requests per hour per token leaves generous headroom
 * over any sane client while bounding what one leaked URL can cost us.
 */
const RATE_LIMIT = { requests: 60, windowMs: 60 * 60 * 1000 };

/**
 * In-process, because L8 says no Redis and the alternative is a table write
 * on every poll -- which is precisely the cost this limiter exists to avoid.
 *
 * The honest consequence: with N server processes the effective limit is
 * N times higher. That is acceptable for a control whose job is to bound
 * abuse rather than to meter fairly, and it is written down here so nobody
 * later mistakes it for a per-tenant quota.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(key: string, now: number): { allowed: boolean; retryAfter: number } {
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
    // Opportunistic sweep: without it this map is a slow memory leak keyed by
    // every token anyone has ever guessed at.
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    }
    return { allowed: true, retryAfter: 0 };
  }

  bucket.count += 1;
  return bucket.count <= RATE_LIMIT.requests
    ? { allowed: true, retryAfter: 0 }
    : { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
}

/** Exported for tests, which must not depend on the previous test's bucket. */
export function resetFeedRateLimits(): void {
  buckets.clear();
}

export function registerFeedRoutes<E extends Env>(app: Hono<E>, db: Database): void {
  app.get('/feeds/:token{.+\\.ics}', async (c) => {
    const raw = c.req.param('token').replace(/\.ics$/, '');

    // Shape-checked before any database work: this endpoint is reachable by
    // anyone, so a malformed URL should cost a regex and nothing more.
    if (!looksLikeFeedToken(raw)) return notFound(c);

    const limit = rateLimit(raw, Date.now());
    if (!limit.allowed) {
      return c.text('Too many requests', 429, {
        'Retry-After': String(limit.retryAfter),
        'Cache-Control': 'no-store',
      });
    }

    // Resolution runs OUTSIDE a tenant context, because the tenant is what it
    // returns. See migration 0002 for why that needs a SECURITY DEFINER
    // function rather than a plain SELECT.
    const resolved = await db.withTenant(
      '',
      async ({ client }) => resolveFeedToken(client, raw),
      { readOnly: true },
    );

    // A revoked or unknown token is 404, never 403. A 403 would confirm the
    // token had once existed, which is a small oracle over a credential
    // space we would rather keep uniform.
    if (!resolved) return notFound(c);

    const feed = await db.withTenant(
      resolved.tenantId,
      async ({ client }) => {
        const calendar = await client.query<{ name: string; time_zone: string }>(
          'SELECT name, time_zone FROM calendars WHERE id = $1',
          [resolved.calendarId],
        );
        if (!calendar.rows[0]) return null;

        const [from, to] = feedWindow();
        const events = await client.query<EventRow>(
          `SELECT id, tenant_id AS "tenantId", calendar_id AS "calendarId", uid, title,
                  description, location, status, timing_kind AS "timingKind",
                  start_local AS "startLocal", end_local AS "endLocal", time_zone AS "timeZone",
                  start_date AS "startDate", end_date AS "endDate", recurrence,
                  exception_dates AS "exceptionDates", sequence, search_span AS "searchSpan",
                  updated_at AS "updatedAt"
             FROM events
            WHERE calendar_id = $1
              AND search_span && tstzrange($2::timestamptz, $3::timestamptz, '[)')
            ORDER BY uid`,
          [resolved.calendarId, from, to],
        );

        const lastModified = events.rows.reduce<Date | null>((latest, row) => {
          const updated = new Date((row as EventRow & { updatedAt: string }).updatedAt);
          return !latest || updated > latest ? updated : latest;
        }, null);

        return {
          name: calendar.rows[0].name,
          timeZone: calendar.rows[0].time_zone,
          // Recurring events keep their RRULE. Expanding them here would
          // multiply the payload by the occurrence count and throw away the
          // client's own, better, expansion -- including its handling of the
          // user's local timezone.
          events: events.rows.map(fromEventRow) as CalendarEvent[],
          lastModified,
        };
      },
      { readOnly: true },
    );

    if (!feed) return notFound(c);

    const body = serializeCalendar({
      events: feed.events,
      name: feed.name,
      timeZone: feed.timeZone,
    });

    // Serialisation is deterministic (DTSTAMP is derived from the event, not
    // the clock), so an unchanged calendar yields an unchanged ETag and every
    // poll after the first costs 304 bytes instead of the whole feed.
    const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
    const lastModified = feed.lastModified?.toUTCString();

    if (isFresh(c, etag, feed.lastModified)) {
      return c.body(null, 304, cacheHeaders(etag, lastModified));
    }

    return c.body(body, 200, {
      // Both the type and the charset matter: Outlook has historically been
      // particular about the full value.
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `inline; filename="${filename(feed.name)}"`,
      ...cacheHeaders(etag, lastModified),
    });
  });
}

/**
 * 404 with an explicitly empty body and no caching.
 *
 * A cached 404 would survive the creation of a legitimate feed at the same
 * URL, which cannot happen with random tokens -- but the habit is worth
 * keeping, and a client that caches a negative answer is very hard to debug.
 */
function notFound(c: Context): Response {
  return c.text('Not found', 404, { 'Cache-Control': 'no-store' });
}

function cacheHeaders(etag: string, lastModified?: string): Record<string, string> {
  return {
    ETag: etag,
    ...(lastModified ? { 'Last-Modified': lastModified } : {}),
    // Short max-age with revalidation: clients poll on their own schedule
    // regardless, and this keeps an intermediary from serving a stale feed
    // for hours. `private` because a feed is one calendar's data.
    'Cache-Control': 'private, max-age=300, must-revalidate',
  };
}

/**
 * Both validators are honoured, because clients disagree about which they
 * send -- and some send `If-Modified-Since` only.
 */
function isFresh(c: Context, etag: string, lastModified: Date | null): boolean {
  const ifNoneMatch = c.req.header('If-None-Match');
  if (ifNoneMatch) {
    const normalise = (value: string) => value.trim().replace(/^W\//, '');
    if (ifNoneMatch.split(',').some((candidate) => normalise(candidate) === normalise(etag))) {
      return true;
    }
    // An If-None-Match that does not match wins outright: RFC 9110 says to
    // ignore If-Modified-Since when If-None-Match is present.
    return false;
  }

  const since = c.req.header('If-Modified-Since');
  if (!since || !lastModified) return false;

  const sinceMs = Date.parse(since);
  // HTTP dates have one-second resolution, so compare at that granularity or
  // a feed modified within the same second looks stale for ever.
  return (
    !Number.isNaN(sinceMs) && Math.floor(lastModified.getTime() / 1000) <= Math.floor(sinceMs / 1000)
  );
}

function feedWindow(): [string, string] {
  const now = new Date();
  const from = new Date(now);
  from.setUTCMonth(from.getUTCMonth() - PAST_MONTHS);
  const to = new Date(now);
  to.setUTCMonth(to.getUTCMonth() + FUTURE_MONTHS);
  return [from.toISOString(), to.toISOString()];
}

/** A filename a human can recognise in a downloads folder. */
function filename(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || 'calendar';
  return `${safe.toLowerCase()}.ics`;
}
