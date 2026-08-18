import { createHash } from 'node:crypto';

/**
 * ETags for embed-heavy pages.
 *
 * A portal may mount several calendars on one page and poll them, so 304s are
 * a large share of the traffic this service will ever see -- cheap to add and
 * central to the "free to operate" claim (L8).
 *
 * THE TENANT IS PART OF THE HASH, and that is not an optimisation detail.
 * Two tenants requesting the same window of the same-named calendar can
 * legitimately produce byte-identical responses -- most obviously when both
 * are empty. If the ETag were derived from the body alone, those two tenants
 * would share a validator, and any cache keyed on URL would be one
 * `If-None-Match` away from confirming another tenant's content. That is a
 * tenancy bug wearing a caching costume, and it gets its own test.
 */
export function computeETag(input: { tenantId: string; key: string; body: string }): string {
  const hash = createHash('sha256')
    // Length-prefixed rather than concatenated, so a tenant id ending in the
    // same characters a key begins with cannot produce a colliding digest.
    .update(`${input.tenantId.length}:${input.tenantId}`)
    .update(`${input.key.length}:${input.key}`)
    .update(input.body)
    .digest('hex');

  return `"${hash.slice(0, 32)}"`;
}

/**
 * RFC 9110 `If-None-Match`: a comma-separated list, or `*`.
 *
 * Weak comparison, because a 304 only has to mean "semantically unchanged"
 * and intermediaries are permitted to weaken a validator in transit.
 */
export function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;

  const normalise = (value: string) => value.trim().replace(/^W\//, '');
  return header.split(',').some((candidate) => normalise(candidate) === normalise(etag));
}

/**
 * Headers that must accompany every tenant-scoped response.
 *
 * `private` keeps shared caches out of it entirely, and `Vary: Authorization`
 * means any cache that ignores that still keys on the credential. Belt and
 * braces on top of the tenant-scoped ETag, because a caching mistake here is
 * a data leak rather than a performance regression.
 */
export const TENANT_CACHE_HEADERS = {
  'Cache-Control': 'private, max-age=0, must-revalidate',
  Vary: 'Authorization',
} as const;
