import { decodeProtectedHeader, jwtVerify } from 'jose';
import type { CalendarId, TenantId } from '@gnomon/core';

/**
 * Host-minted token verification (ADR-0004, ADR-0009).
 *
 * Gnomon issues nothing. The host portal's backend signs a short-lived JWT
 * with an Ed25519 private key we never see, and we verify it against a public
 * key registered at onboarding.
 *
 * Deliberately framework-agnostic: this is the security boundary, and it
 * should be testable without standing up an HTTP server. The Hono middleware
 * in `middleware.ts` is a thin wrapper.
 *
 * TOKEN CONTRACT
 *
 *   header  { alg: "EdDSA", kid: "<key id>" }
 *   claims  { aud: "gnomon",
 *             sub: "<opaque subject, the host's own user id>",
 *             tid: "<tenant id>",
 *             cal: ["<calendar id>", ...],
 *             scp: ["events:read", ...],
 *             iat, exp }
 *
 * The `kid` header selects the key. ADR-0004 sketched this as an `iss` claim
 * holding a key id; the standard JOSE header is used instead, since every
 * signing library already emits it and key selection belongs in the header
 * rather than in claims we have not yet authenticated.
 */

export type Scope = 'events:read' | 'events:write';

export interface RegisteredKey {
  kid: string;
  /**
   * The tenant this key belongs to. This -- not the token's `tid` claim -- is
   * the authoritative tenant for a request. See `verifyToken`.
   */
  tenantId: TenantId;
  publicKey: CryptoKey;
}

export interface KeyRegistry {
  findByKid(kid: string): Promise<RegisteredKey | undefined>;
}

export interface VerifiedToken {
  tenantId: TenantId;
  subject: string;
  calendarIds: readonly CalendarId[];
  scopes: readonly Scope[];
  expiresAt: Date;
}

export type RejectionReason =
  | 'malformed'
  | 'unsupported_algorithm'
  | 'unknown_key'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_audience'
  | 'missing_claim'
  | 'tenant_mismatch'
  | 'excessive_lifetime';

/**
 * Carries a machine-readable reason for logs and tests. Callers must NOT
 * return `reason` to the client: distinguishing "unknown key" from "bad
 * signature" tells an attacker which half of their guess was right. The HTTP
 * layer answers 401 and nothing else.
 */
export class TokenRejectedError extends Error {
  constructor(
    readonly reason: RejectionReason,
    detail?: string,
  ) {
    super(detail ? `Token rejected (${reason}): ${detail}` : `Token rejected (${reason})`);
    this.name = 'TokenRejectedError';
  }
}

export interface VerifyOptions {
  /** Must match the token's `aud`. */
  audience?: string;
  /**
   * Longest token lifetime we will honour, in seconds. A token minted with a
   * ten-year expiry is cryptographically valid and operationally a standing
   * liability; rejecting it turns a silent risk into an integrator's error
   * message. ADR-0004 models ~5 minutes, so this leaves real headroom.
   */
  maxLifetimeSeconds?: number;
  /** Tolerance for clock drift between us and the integrator, in seconds. */
  clockToleranceSeconds?: number;
  /** Injectable for tests. */
  now?: () => Date;
}

const DEFAULTS = {
  audience: 'gnomon',
  maxLifetimeSeconds: 900,
  clockToleranceSeconds: 30,
} as const;

/**
 * The one algorithm we accept, and the control that actually enforces it.
 *
 * This is a security property, not a limitation. Supporting a second
 * algorithm is what makes confusion attacks possible: the verifier must then
 * map `alg` to a key type correctly on every path forever, and the failure
 * mode -- an HMAC verified against the bytes of a public key -- is silent and
 * total.
 *
 * Verified by experiment rather than assumed. With the header pre-check below
 * removed, this allowlist alone still rejects an HS256 token MACed with the
 * Ed25519 public key. Widen it to `['EdDSA', 'HS256']` and that same forgery
 * VERIFIES -- an attacker holding only the public key we publish can mint a
 * token for the tenant. The test in `test/tokens.test.ts` is what catches it.
 *
 * So: do not add an entry here to support an integrator. That is an ADR-0009
 * conversation, and the answer is very likely a second `kid` instead.
 */
const ALLOWED_ALGORITHMS = ['EdDSA'] as const;

export async function verifyToken(
  token: string,
  registry: KeyRegistry,
  options: VerifyOptions = {},
): Promise<VerifiedToken> {
  const audience = options.audience ?? DEFAULTS.audience;
  const maxLifetime = options.maxLifetimeSeconds ?? DEFAULTS.maxLifetimeSeconds;
  const clockTolerance = options.clockToleranceSeconds ?? DEFAULTS.clockToleranceSeconds;
  const now = options.now?.() ?? new Date();

  // The header is unauthenticated at this point. It is used ONLY to choose a
  // candidate key and to reject obviously-wrong algorithms early; every value
  // that matters is re-checked after the signature validates.
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new TokenRejectedError('malformed');
  }

  if (header.alg !== 'EdDSA') {
    // Defence in depth, not the primary control -- ALLOWED_ALGORITHMS is
    // (see the note there). This exists to reject `alg: none` and confusion
    // attempts before we spend a key lookup on them, and to give a clearer
    // reason than jose's generic one.
    throw new TokenRejectedError('unsupported_algorithm', String(header.alg));
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    throw new TokenRejectedError('malformed', 'no kid');
  }

  const key = await registry.findByKid(header.kid);
  if (!key) throw new TokenRejectedError('unknown_key');

  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    ({ payload } = await jwtVerify(token, key.publicKey, {
      algorithms: [...ALLOWED_ALGORITHMS],
      audience,
      clockTolerance,
      currentDate: now,
      requiredClaims: ['sub', 'tid', 'iat', 'exp'],
    }));
  } catch (error) {
    throw translateJoseError(error);
  }

  // THE CRITICAL CHECK.
  //
  // A valid signature proves who signed the token. It says nothing about what
  // they are entitled to claim. Without this, tenant A -- holding a perfectly
  // legitimate key -- could mint a token asserting `tid: B` and read tenant
  // B's calendars, and every signature check would pass.
  //
  // The tenant therefore comes from the KEY. The claim is only cross-checked.
  if (payload.tid !== key.tenantId) {
    throw new TokenRejectedError(
      'tenant_mismatch',
      `key ${key.kid} belongs to a different tenant than the token claims`,
    );
  }

  const issuedAt = payload.iat as number;
  const expiresAt = payload.exp as number;
  if (expiresAt - issuedAt > maxLifetime) {
    throw new TokenRejectedError(
      'excessive_lifetime',
      `${expiresAt - issuedAt}s exceeds the ${maxLifetime}s maximum`,
    );
  }

  return {
    tenantId: key.tenantId,
    subject: String(payload.sub),
    calendarIds: readStringArray(payload.cal) as CalendarId[],
    scopes: readStringArray(payload.scp).filter(isScope),
    expiresAt: new Date(expiresAt * 1000),
  };
}

/** True when the token grants `scope` on `calendarId`. */
export function permits(
  token: VerifiedToken,
  scope: Scope,
  calendarId?: CalendarId,
): boolean {
  if (!token.scopes.includes(scope)) return false;
  // An empty `cal` list grants no calendars rather than all of them. The
  // permissive reading of an omitted claim is how scoping bugs become data
  // leaks, and phase 6.2 depends on this being restrictive.
  if (calendarId !== undefined && !token.calendarIds.includes(calendarId)) return false;
  return true;
}

function translateJoseError(error: unknown): TokenRejectedError {
  const code = (error as { code?: string } | null)?.code;

  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return new TokenRejectedError('expired');
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
      const claim = (error as { claim?: string }).claim;
      if (claim === 'aud') return new TokenRejectedError('wrong_audience');
      if (claim === 'nbf') return new TokenRejectedError('not_yet_valid');
      return new TokenRejectedError('missing_claim', claim);
    }
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return new TokenRejectedError('bad_signature');
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return new TokenRejectedError('unsupported_algorithm');
    default:
      // Anything unrecognised fails closed as a bad signature rather than
      // surfacing an internal error -- a verifier that throws 500 on a
      // malformed token is a denial-of-service lever.
      return new TokenRejectedError('bad_signature', code);
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isScope(value: string): value is Scope {
  return value === 'events:read' || value === 'events:write';
}
