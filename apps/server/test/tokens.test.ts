import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, exportSPKI, generateKeyPair, base64url } from 'jose';
import type { CalendarId, TenantId } from '@gnomon/core';
import { InMemoryKeyRegistry, registerJwkKey, registerSpkiKey } from '../src/auth/registry.js';
import { TokenRejectedError, permits, verifyToken } from '../src/auth/tokens.js';
import type { RejectionReason, VerifiedToken } from '../src/auth/tokens.js';

const TENANT_A = 'tenant-a' as TenantId;
const TENANT_B = 'tenant-b' as TenantId;
const CAL_A1 = 'cal-a1' as CalendarId;
const CAL_A2 = 'cal-a2' as CalendarId;

const NOW = new Date('2026-08-14T12:00:00Z');
const now = () => NOW;
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

let registry: InMemoryKeyRegistry;
let keyA: CryptoKeyPair;
let keyB: CryptoKeyPair;

beforeAll(async () => {
  registry = new InMemoryKeyRegistry();

  keyA = (await generateKeyPair('Ed25519', { extractable: true })) as CryptoKeyPair;
  keyB = (await generateKeyPair('Ed25519', { extractable: true })) as CryptoKeyPair;

  await registerSpkiKey(registry, {
    kid: 'key-a',
    tenantId: TENANT_A,
    spki: await exportSPKI(keyA.publicKey),
  });
  await registerSpkiKey(registry, {
    kid: 'key-b',
    tenantId: TENANT_B,
    spki: await exportSPKI(keyB.publicKey),
  });
});

interface MintOptions {
  kid?: string;
  key?: CryptoKey;
  tid?: string;
  aud?: string;
  sub?: string;
  cal?: unknown;
  scp?: unknown;
  issuedAt?: Date;
  lifetimeSeconds?: number;
  omit?: ('sub' | 'tid' | 'iat' | 'exp')[];
}

/** Mints a token the way a well-behaved integrator's backend would. */
async function mint(options: MintOptions = {}): Promise<string> {
  const issuedAt = options.issuedAt ?? NOW;
  const omit = options.omit ?? [];

  const claims: Record<string, unknown> = {
    cal: options.cal ?? [CAL_A1],
    scp: options.scp ?? ['events:read'],
  };
  if (!omit.includes('sub')) claims.sub = options.sub ?? 'resident-42';
  if (!omit.includes('tid')) claims.tid = options.tid ?? TENANT_A;

  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid: options.kid ?? 'key-a' })
    .setAudience(options.aud ?? 'gnomon');

  if (!omit.includes('iat')) jwt = jwt.setIssuedAt(seconds(issuedAt));
  if (!omit.includes('exp')) {
    jwt = jwt.setExpirationTime(seconds(issuedAt) + (options.lifetimeSeconds ?? 300));
  }

  return jwt.sign(options.key ?? keyA.privateKey);
}

/** Asserts rejection AND the specific reason, so a test cannot pass by accident. */
async function expectRejection(token: Promise<string> | string, reason: RejectionReason) {
  const error = await verifyToken(await token, registry, { now }).then(
    () => null,
    (caught: unknown) => caught,
  );

  expect(error, `expected rejection with reason "${reason}", but the token verified`).toBeInstanceOf(
    TokenRejectedError,
  );
  expect((error as TokenRejectedError).reason).toBe(reason);
}

describe('a well-formed token', () => {
  it('verifies and yields the tenant, subject, calendars and scopes', async () => {
    const verified = await verifyToken(await mint(), registry, { now });

    expect(verified).toEqual<VerifiedToken>({
      tenantId: TENANT_A,
      subject: 'resident-42',
      calendarIds: [CAL_A1],
      scopes: ['events:read'],
      expiresAt: new Date('2026-08-14T12:05:00Z'),
    });
  });

  it('accepts a key registered in JWK form', async () => {
    await registerJwkKey(registry, {
      kid: 'key-a-jwk',
      tenantId: TENANT_A,
      jwk: (await exportJWK(keyA.publicKey)) as Record<string, unknown>,
    });

    const verified = await verifyToken(await mint({ kid: 'key-a-jwk' }), registry, { now });
    expect(verified.tenantId).toBe(TENANT_A);
  });

  it('tolerates small clock drift at the host', async () => {
    // Minted 10s in our future by a slightly fast integrator clock.
    const token = await mint({ issuedAt: new Date(NOW.getTime() + 10_000) });
    await expect(verifyToken(token, registry, { now })).resolves.toBeDefined();
  });
});

describe('the tenant comes from the key, not from the claim', () => {
  it('rejects a validly-signed token asserting another tenant', async () => {
    // THE attack this design exists to stop. Tenant A holds a legitimate key
    // and mints a perfectly valid token claiming to be tenant B. Every
    // signature check passes; only the key-to-claim cross-check catches it.
    await expectRejection(mint({ tid: TENANT_B }), 'tenant_mismatch');
  });

  it('rejects a token signed by tenant B but sent with tenant A\'s kid', async () => {
    // The mirror: correct claim, wrong signer. The signature fails against
    // the key that kid names.
    await expectRejection(mint({ kid: 'key-a', key: keyB.privateKey }), 'bad_signature');
  });

  it('never reports a tenant the key does not own', async () => {
    const verified = await verifyToken(
      await mint({ kid: 'key-b', key: keyB.privateKey, tid: TENANT_B }),
      registry,
      { now },
    );
    expect(verified.tenantId).toBe(TENANT_B);
  });
});

describe('algorithm confusion', () => {
  it('rejects alg: none', async () => {
    const header = base64url.encode(JSON.stringify({ alg: 'none', kid: 'key-a' }));
    const payload = base64url.encode(
      JSON.stringify({ sub: 'x', tid: TENANT_A, aud: 'gnomon', iat: seconds(NOW), exp: seconds(NOW) + 300 }),
    );
    await expectRejection(`${header}.${payload}.`, 'unsupported_algorithm');
  });

  it('rejects an HS256 token whose MAC key is the Ed25519 public key bytes', async () => {
    // The classic confusion attack: take the public key we publish, use it as
    // an HMAC secret, and hope the verifier picks its algorithm from the
    // header. A single-entry allowlist means there is no branch to trick.
    const jwk = (await exportJWK(keyA.publicKey)) as { x: string };
    const secret = base64url.decode(jwk.x);

    const header = base64url.encode(JSON.stringify({ alg: 'HS256', kid: 'key-a' }));
    const payload = base64url.encode(
      JSON.stringify({ sub: 'x', tid: TENANT_A, aud: 'gnomon', iat: seconds(NOW), exp: seconds(NOW) + 300 }),
    );
    const data = new TextEncoder().encode(`${header}.${payload}`);
    const macKey = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = base64url.encode(new Uint8Array(await crypto.subtle.sign('HMAC', macKey, data)));

    await expectRejection(`${header}.${payload}.${signature}`, 'unsupported_algorithm');
  });

  it('rejects a token with no kid', async () => {
    const token = await new SignJWT({ sub: 'x', tid: TENANT_A })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setAudience('gnomon')
      .setIssuedAt(seconds(NOW))
      .setExpirationTime(seconds(NOW) + 300)
      .sign(keyA.privateKey);

    await expectRejection(token, 'malformed');
  });

  it('rejects an unknown kid', async () => {
    await expectRejection(mint({ kid: 'key-that-was-retired' }), 'unknown_key');
  });

  it('rejects a tampered payload', async () => {
    const token = await mint();
    const [header, , signature] = token.split('.');
    const forged = base64url.encode(
      JSON.stringify({ sub: 'x', tid: TENANT_A, aud: 'gnomon', scp: ['events:write'], iat: seconds(NOW), exp: seconds(NOW) + 300 }),
    );
    await expectRejection(`${header}.${forged}.${signature}`, 'bad_signature');
  });

  it('rejects garbage', async () => {
    await expectRejection('not-a-jwt', 'malformed');
  });
});

describe('lifetime and claims', () => {
  it('rejects an expired token', async () => {
    await expectRejection(mint({ issuedAt: new Date(NOW.getTime() - 3_600_000) }), 'expired');
  });

  it('rejects a token minted with an excessive lifetime', async () => {
    // Cryptographically valid and operationally a standing liability. A
    // ten-year token should be an integrator's error message, not our
    // problem later.
    await expectRejection(mint({ lifetimeSeconds: 60 * 60 * 24 * 3650 }), 'excessive_lifetime');
  });

  it('accepts a lifetime exactly at the maximum', async () => {
    const token = await mint({ lifetimeSeconds: 900 });
    await expect(verifyToken(token, registry, { now })).resolves.toBeDefined();
  });

  it('rejects the wrong audience', async () => {
    await expectRejection(mint({ aud: 'some-other-service' }), 'wrong_audience');
  });

  for (const claim of ['sub', 'tid', 'iat', 'exp'] as const) {
    it(`rejects a token missing ${claim}`, async () => {
      // All four are declared to jose as required, so an absent claim is
      // refused before any of our own checks run. `tid` in particular never
      // reaches the tenant cross-check -- which is the better ordering, since
      // "you omitted a claim" is a more actionable error for an integrator
      // than "your tenant did not match".
      await expectRejection(mint({ omit: [claim] }), 'missing_claim');
    });
  }
});

describe('key retirement', () => {
  it('stops honouring a retired key immediately', async () => {
    const retiring = (await generateKeyPair('Ed25519', { extractable: true })) as CryptoKeyPair;
    await registerSpkiKey(registry, {
      kid: 'key-retiring',
      tenantId: TENANT_A,
      spki: await exportSPKI(retiring.publicKey),
    });

    const token = await mint({ kid: 'key-retiring', key: retiring.privateKey });
    await expect(verifyToken(token, registry, { now })).resolves.toBeDefined();

    // Retirement is the only revocation lever ADR-0004 leaves us, since
    // tokens themselves expire rather than being revoked.
    registry.remove('key-retiring');
    await expectRejection(token, 'unknown_key');
  });

  it('lets a tenant hold several concurrent keys, which is what makes rotation safe', async () => {
    const next = (await generateKeyPair('Ed25519', { extractable: true })) as CryptoKeyPair;
    await registerSpkiKey(registry, {
      kid: 'key-a-next',
      tenantId: TENANT_A,
      spki: await exportSPKI(next.publicKey),
    });

    await expect(verifyToken(await mint({ kid: 'key-a' }), registry, { now })).resolves.toBeDefined();
    await expect(
      verifyToken(await mint({ kid: 'key-a-next', key: next.privateKey }), registry, { now }),
    ).resolves.toBeDefined();
  });
});

describe('registration refuses keys that would be wrong or dangerous', () => {
  it('refuses a private key', async () => {
    // Storing a private key would work perfectly and would put minting
    // capability in our database -- exactly what ADR-0009 exists to prevent.
    const jwk = (await exportJWK(keyA.privateKey)) as Record<string, unknown>;
    await expect(
      registerJwkKey(registry, { kid: 'oops', tenantId: TENANT_A, jwk }),
    ).rejects.toThrow(/private component/i);
  });

  it('refuses a non-Ed25519 key at registration rather than on the auth path', async () => {
    const rsa = await generateKeyPair('RS256', { extractable: true });
    const jwk = (await exportJWK(rsa.publicKey)) as Record<string, unknown>;
    await expect(
      registerJwkKey(registry, { kid: 'rsa', tenantId: TENANT_A, jwk }),
    ).rejects.toThrow(/Ed25519/i);
  });
});

describe('permits', () => {
  const token: VerifiedToken = {
    tenantId: TENANT_A,
    subject: 'resident-42',
    calendarIds: [CAL_A1],
    scopes: ['events:read'],
    expiresAt: NOW,
  };

  it('grants a held scope on a listed calendar', () => {
    expect(permits(token, 'events:read', CAL_A1)).toBe(true);
  });

  it('refuses a scope the token does not hold', () => {
    expect(permits(token, 'events:write', CAL_A1)).toBe(false);
  });

  it('refuses a calendar the token does not list, within the same tenant', () => {
    // RLS enforces the tenant boundary; the CALENDAR boundary is this
    // function's job and RLS will not catch it (phase 6.2).
    expect(permits(token, 'events:read', CAL_A2)).toBe(false);
  });

  it('treats an empty calendar list as granting nothing', () => {
    // The permissive reading of an omitted claim is how scoping bugs become
    // data leaks.
    expect(permits({ ...token, calendarIds: [] }, 'events:read', CAL_A1)).toBe(false);
  });
});
