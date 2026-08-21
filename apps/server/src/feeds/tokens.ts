import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * ICS feed tokens (phase 5.1).
 *
 * These are NOT the JWTs of ADR-0004. Those live five minutes and are minted
 * per request by the host portal. A feed URL is pasted into Apple Calendar
 * once and polled every fifteen minutes for the next three years. Different
 * lifetime, different threat model, deliberately a different table -- and the
 * one place in Gnomon where a long-lived bearer credential exists at all.
 *
 * Four properties follow from that, and each is a requirement rather than a
 * nicety:
 *
 *   * OPAQUE. Nothing derivable from the calendar id, so possessing one feed
 *     URL tells you nothing about any other.
 *   * NO PII. Calendar clients leak URLs into logs, sync services, support
 *     tickets and screenshots. Anything in the URL is effectively public.
 *   * HASHED AT REST. A database read must not yield working feed URLs -- the
 *     same reasoning as password storage, for the same reason.
 *   * INDIVIDUALLY REVOCABLE, so one leak does not force every subscriber to
 *     re-add their calendar.
 */

/**
 * 32 bytes of CSPRNG output, base64url-encoded to 43 characters.
 *
 * Sized against offline guessing rather than online: the token appears in a
 * URL, so it will end up somewhere it can be attacked at leisure. 256 bits
 * makes that pointless, and the URL is only ~20 characters longer than a
 * shorter token would have been.
 */
const TOKEN_BYTES = 32;

export interface FeedToken {
  /** Shown ONCE, at creation. We cannot show it again and should not try. */
  token: string;
  hash: string;
}

export function mintFeedToken(): FeedToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashFeedToken(token) };
}

/**
 * SHA-256, deliberately unsalted and un-stretched.
 *
 * This is not a password. It is 256 bits of uniform randomness, so there is
 * no dictionary to attack and no rainbow table to build -- and a slow KDF
 * would put a deliberate delay on the hot path of a feed that gets polled
 * every fifteen minutes by every subscriber. Salting would also make lookup
 * by hash impossible without scanning the table.
 */
export function hashFeedToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison, for callers that compare hashes directly.
 *
 * The database lookup below compares in SQL and is not constant-time, which
 * is acceptable: an index probe on a 256-bit random value leaks nothing an
 * attacker can steer. This exists for the paths that do compare in process.
 */
export function feedTokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface ResolvedFeed {
  tenantId: string;
  calendarId: string;
}

/**
 * Resolves a token to its tenant and calendar.
 *
 * Goes through the SECURITY DEFINER function from migration 0002, because RLS
 * policies read a tenant that is not known until this returns. Everything
 * else about feed tokens -- listing, creating, revoking -- goes through
 * ordinary tenant-scoped SQL.
 */
export async function resolveFeedToken(
  client: PoolClient,
  token: string,
): Promise<ResolvedFeed | null> {
  const { rows } = await client.query<{ tenant_id: string; calendar_id: string }>(
    'SELECT tenant_id, calendar_id FROM gnomon_resolve_feed_token($1)',
    [hashFeedToken(token)],
  );

  const row = rows[0];
  return row ? { tenantId: row.tenant_id, calendarId: row.calendar_id } : null;
}

/**
 * A token is only valid in the shape we mint.
 *
 * Rejecting the wrong shape early means a malformed URL costs a regex rather
 * than a database round trip, which matters on a public endpoint that anyone
 * can hit.
 */
export function looksLikeFeedToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
