#!/usr/bin/env node
/**
 * Generate an Ed25519 key pair for minting Gnomon embed tokens.
 * Node 22+, ZERO dependencies.
 *
 *   node keygen.mjs --out ./keys --kid portal-2026-08
 *
 * Writes:
 *   <out>/<kid>.private.pem   KEEP SECRET. Never leaves your infrastructure.
 *   <out>/<kid>.public.pem    Register this with Gnomon. Safe to email.
 *
 * The asymmetry is the point (ADR-0009): Gnomon stores only the public key,
 * so a compromise of Gnomon cannot mint tokens for you. That is not true of
 * a shared-secret scheme, which is why we do not offer one.
 *
 * Name the kid for the period it covers -- `portal-2026-08` rather than
 * `portal-key` -- because you will eventually rotate, and a name that
 * already implies a successor makes that a routine act.
 */

import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag?.startsWith('--')) continue;
    args[flag.slice(2)] = argv[i + 1];
  }
  return args;
}

export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = args.out ?? '.';
  const kid = args.kid ?? `portal-${new Date().toISOString().slice(0, 7)}`;

  const { privateKeyPem, publicKeyPem } = generateKeyPair();

  mkdirSync(out, { recursive: true });
  // 0600: the private key is the only thing standing between an attacker and
  // the ability to impersonate any of your users to Gnomon.
  writeFileSync(join(out, `${kid}.private.pem`), privateKeyPem, { mode: 0o600 });
  writeFileSync(join(out, `${kid}.public.pem`), publicKeyPem);

  console.log(`kid:     ${kid}`);
  console.log(`private: ${join(out, `${kid}.private.pem`)}  (keep secret, mode 0600)`);
  console.log(`public:  ${join(out, `${kid}.public.pem`)}  (register with Gnomon)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
