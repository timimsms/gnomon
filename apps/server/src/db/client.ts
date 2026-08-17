import { Pool, types, type PoolClient } from 'pg';

/**
 * `pg` parses date-ish columns into JS `Date` objects by default. For this
 * schema that is not a convenience, it is a correctness bug:
 *
 *   * `date` (OID 1082) holds a FLOATING date (ADR-0005). Handing it to the
 *     `Date` constructor anchors it to the server's timezone, so a holiday
 *     stored as 2026-10-03 comes back as 2026-10-02T22:00Z west of Greenwich
 *     and renders on the wrong day. This is the same hazard that bit the ICS
 *     parser, arriving from the other direction.
 *   * `timestamp without time zone` (OID 1114) holds WALL-CLOCK time whose
 *     zone lives in a separate column. A `Date` implies an instant it does not
 *     have, and the offset applied would be the server's.
 *
 * Both must stay strings all the way to `@gnomon/core`, which is the only
 * thing entitled to interpret them. Registered once here, because the module
 * that owns connections is the honest place for it.
 */
types.setTypeParser(1082, (value) => value); // date
types.setTypeParser(1114, (value) => value); // timestamp without time zone

/**
 * Database access, scoped to a tenant.
 *
 * This module is the bridge between the two halves of phase 2: the token
 * verifier decides which tenant a request belongs to, and the RLS policies
 * read `gnomon.tenant_id` to enforce it. `withTenant` is the only thing that
 * connects them, which is deliberate -- there should be exactly one place
 * where a request's tenancy is established, and it should be hard to bypass.
 */

export interface TenantScope {
  readonly tenantId: string;
  readonly client: PoolClient;
}

export interface Database {
  withTenant<T>(
    tenantId: string,
    work: (scope: TenantScope) => Promise<T>,
    options?: { readOnly?: boolean },
  ): Promise<T>;
  close(): Promise<void>;
}

export function createDatabase(connectionString: string, max = 10): Database {
  const pool = new Pool({ connectionString, max });

  return {
    async withTenant(tenantId, work, options = {}) {
      const client = await pool.connect();
      try {
        // READ ONLY on read paths is defence in depth: a read endpoint that
        // somehow reached a write becomes an error rather than a mutation.
        // Phase 6 will pass readOnly: false explicitly, which makes the
        // writing endpoints obvious in review.
        await client.query(options.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');

        // Transaction-local (the `true`), so a pooled connection cannot carry
        // tenant context into whoever checks it out next. `SET` or
        // `set_config(..., false)` would persist on the physical connection
        // and hand one tenant's context to the next request.
        await client.query(`SELECT set_config('gnomon.tenant_id', $1, true)`, [tenantId]);

        const result = await work({ tenantId, client });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}
