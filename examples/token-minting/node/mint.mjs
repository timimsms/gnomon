#!/usr/bin/env node
/**
 * Mint a Gnomon embed token. Node 22+, ZERO dependencies.
 *
 * This is the code your portal's backend runs to tell Gnomon who is looking
 * at the calendar. Gnomon has no accounts and issues nothing (ADR-0004); it
 * verifies what you sign here and inherits your identity model.
 *
 * Copy this file. It is deliberately dependency-free so you can read all of
 * it before trusting it -- Node's built-in crypto does Ed25519, so a JWT
 * library is not required.
 *
 *   node mint.mjs --key private.pem --kid portal-2026-08 \
 *     --tenant acme --subject resident-42 \
 *     --calendars cal-maintenance,cal-community --scopes events:read
 *
 * Prints the token to stdout. Hand it to the embed; never to the browser
 * before the user is authenticated on your side.
 */

import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * How long a token is valid. Keep this SHORT.
 *
 * Gnomon has no revocation list: a leaked token is valid until it expires
 * and nothing can call it back. Five minutes bounds the damage, and the embed
 * refreshes silently, so users never notice. Gnomon rejects anything over 15
 * minutes outright.
 */
const DEFAULT_TTL_SECONDS = 300;

/** RFC 7515 base64url: no padding, URL-safe alphabet. */
function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function mintToken({
  privateKeyPem,
  kid,
  tenantId,
  subject,
  calendarIds = [],
  scopes = ['events:read'],
  ttlSeconds = DEFAULT_TTL_SECONDS,
  audience = 'gnomon',
  now = () => new Date(),
}) {
  const issuedAt = Math.floor(now().getTime() / 1000);

  const header = {
    alg: 'EdDSA',
    typ: 'JWT',
    // Tells Gnomon WHICH of your registered keys signed this. Required.
    // It is also what makes key rotation possible without downtime: register
    // the new key, start sending the new kid, then retire the old one.
    kid,
  };

  const payload = {
    aud: audience,
    // Opaque to Gnomon. It never learns a name or an email from this -- use
    // your own internal user id, not something personally identifying.
    sub: subject,
    tid: tenantId,
    // The calendars this user may see. An empty list grants NOTHING, so be
    // explicit; Gnomon will not infer access from the tenant alone.
    cal: calendarIds,
    scp: scopes,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

  // Ed25519 takes `null` as the digest algorithm: the scheme specifies its
  // own hashing internally. Passing 'sha256' here throws.
  const signature = sign(null, Buffer.from(signingInput), createPrivateKey(privateKeyPem));

  return `${signingInput}.${base64url(signature)}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag?.startsWith('--')) continue;
    args[flag.slice(2)] = argv[i + 1];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = ['key', 'kid', 'tenant', 'subject'];
  const missing = required.filter((name) => !args[name]);

  if (missing.length) {
    console.error(`Missing required argument(s): ${missing.map((m) => `--${m}`).join(', ')}`);
    console.error(
      'Usage: node mint.mjs --key private.pem --kid <kid> --tenant <id> --subject <id>' +
        ' [--calendars a,b] [--scopes events:read] [--ttl 300]',
    );
    process.exit(2);
  }

  const token = mintToken({
    privateKeyPem: readFileSync(args.key, 'utf8'),
    kid: args.kid,
    tenantId: args.tenant,
    subject: args.subject,
    calendarIds: args.calendars ? args.calendars.split(',').filter(Boolean) : [],
    scopes: args.scopes ? args.scopes.split(',').filter(Boolean) : ['events:read'],
    ttlSeconds: args.ttl ? Number(args.ttl) : DEFAULT_TTL_SECONDS,
    ...(args.audience ? { audience: args.audience } : {}),
  });

  process.stdout.write(token);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
