import { importSPKI, importJWK } from 'jose';
import type { TenantId } from '@gnomon/core';
import type { KeyRegistry, RegisteredKey } from './tokens.js';

/**
 * Key registries.
 *
 * A registry answers one question: which tenant owns this `kid`, and what
 * public key verifies it? Postgres backs this in production (phase 2.2); the
 * in-memory implementation here serves tests, the demo tenant, and
 * single-tenant self-hosted deployments configured from a file.
 *
 * Note that a registry holds ONLY public keys. That is the whole point of
 * ADR-0009: a full dump of this table lets an attacker verify tokens, which
 * they could already do, and mint nothing.
 */

export class InMemoryKeyRegistry implements KeyRegistry {
  readonly #keys = new Map<string, RegisteredKey>();

  add(key: RegisteredKey): this {
    this.#keys.set(key.kid, key);
    return this;
  }

  /**
   * Retiring a key must take effect immediately rather than at the next
   * restart -- it is the only revocation mechanism ADR-0004 leaves us, since
   * tokens themselves are revoked only by expiry.
   */
  remove(kid: string): boolean {
    return this.#keys.delete(kid);
  }

  findByKid(kid: string): Promise<RegisteredKey | undefined> {
    return Promise.resolve(this.#keys.get(kid));
  }
}

/**
 * A tenant may have several active keys at once. This is what makes rotation
 * possible without downtime, and it is the mitigation for the one real cost
 * of deferring JWKS (ADR-0009): register kid N+1, let the integrator deploy,
 * then retire kid N.
 */
export async function registerSpkiKey(
  registry: InMemoryKeyRegistry,
  input: { kid: string; tenantId: TenantId; spki: string },
): Promise<RegisteredKey> {
  const publicKey = await importSPKI(input.spki, 'Ed25519');
  const key: RegisteredKey = {
    kid: input.kid,
    tenantId: input.tenantId,
    publicKey: publicKey as CryptoKey,
  };
  registry.add(key);
  return key;
}

/** JWK form, for integrators who already publish keys that way. */
export async function registerJwkKey(
  registry: InMemoryKeyRegistry,
  input: { kid: string; tenantId: TenantId; jwk: Record<string, unknown> },
): Promise<RegisteredKey> {
  if (input.jwk.kty !== 'OKP' || input.jwk.crv !== 'Ed25519') {
    // Fail loudly at registration rather than at 3am on the auth path. An
    // RSA key registered here would simply never verify anything.
    throw new Error(
      `Key ${input.kid} is not Ed25519 (kty=${String(input.jwk.kty)}, crv=${String(input.jwk.crv)}). Gnomon accepts EdDSA only -- see ADR-0009.`,
    );
  }
  if ('d' in input.jwk) {
    // Registering a private key would work, and would defeat the entire point
    // of ADR-0009 by putting minting capability in our database.
    throw new Error(
      `Key ${input.kid} contains a private component. Register the PUBLIC key only.`,
    );
  }

  const publicKey = await importJWK(input.jwk as Parameters<typeof importJWK>[0], 'EdDSA');
  const key: RegisteredKey = {
    kid: input.kid,
    tenantId: input.tenantId,
    publicKey: publicKey as CryptoKey,
  };
  registry.add(key);
  return key;
}
