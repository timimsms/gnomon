import { importSPKI } from 'jose';
import type { TenantId } from '@gnomon/core';
import type { Pool } from 'pg';
import type { KeyRegistry, RegisteredKey } from '../auth/tokens.js';

/**
 * The production key registry: Postgres-backed, with a small cache.
 *
 * `tenant_keys` carries no RLS policy, and cannot -- the lookup here is what
 * establishes which tenant a request belongs to, so a tenant-scoped policy
 * would gate the query that produces the tenant (ADR-0010, and the note in
 * 0001_rls_policies.sql). It holds public keys only.
 */
export class PostgresKeyRegistry implements KeyRegistry {
  readonly #pool: Pool;
  readonly #cache = new Map<string, { key: RegisteredKey; expiresAt: number }>();
  readonly #ttlMs: number;

  constructor(pool: Pool, options: { cacheTtlMs?: number } = {}) {
    this.#pool = pool;
    // Short, because retirement is the only revocation lever we have
    // (ADR-0004) and a cache is exactly what would keep a retired key alive.
    this.#ttlMs = options.cacheTtlMs ?? 30_000;
  }

  async findByKid(kid: string): Promise<RegisteredKey | undefined> {
    const cached = this.#cache.get(kid);
    if (cached && cached.expiresAt > Date.now()) return cached.key;

    const { rows } = await this.#pool.query<{ tenant_id: string; public_key_spki: string }>(
      // `retired_at IS NULL` is the revocation. Omitting it would make
      // retirement decorative, which is the whole reason the column exists.
      `SELECT tenant_id, public_key_spki FROM tenant_keys
        WHERE kid = $1 AND retired_at IS NULL`,
      [kid],
    );

    const row = rows[0];
    if (!row) {
      // Negative results are deliberately NOT cached: an unknown kid is the
      // shape of an attack, and caching it would let a burst of bad tokens
      // evict real keys.
      return undefined;
    }

    const key: RegisteredKey = {
      kid,
      tenantId: row.tenant_id as TenantId,
      publicKey: (await importSPKI(row.public_key_spki, 'Ed25519')) as CryptoKey,
    };

    this.#cache.set(kid, { key, expiresAt: Date.now() + this.#ttlMs });
    return key;
  }

  /** Drops the cache. Used after registering or retiring a key. */
  invalidate(kid?: string): void {
    if (kid) this.#cache.delete(kid);
    else this.#cache.clear();
  }
}
