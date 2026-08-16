import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base64url } from 'jose';
import type { CalendarId, TenantId } from '@gnomon/core';
import { InMemoryKeyRegistry, registerSpkiKey } from '../src/auth/registry.js';
import { verifyToken } from '../src/auth/tokens.js';

/**
 * The reference implementations, exercised against the REAL verifier.
 *
 * These examples are the first thing an integrator reads and the code they
 * paste into their backend. An example that has never been run against the
 * thing it talks to is a liability, not documentation -- so this suite mints
 * with each implementation and verifies the result through exactly the code
 * path a production request takes.
 *
 * If one of these fails, the example is wrong. Fix the example.
 */

const EXAMPLES = fileURLToPath(new URL('../../../examples/token-minting', import.meta.url));
const NODE_DIR = join(EXAMPLES, 'node');
const GO_DIR = join(EXAMPLES, 'go');

const TENANT = 'acme' as TenantId;
const KID = 'portal-2026-08';
const CAL_A = 'cal-maintenance' as CalendarId;
const CAL_B = 'cal-community' as CalendarId;

let workDir: string;
let privateKeyPath: string;
let registry: InMemoryKeyRegistry;

/** True when the toolchain for a given example is present. */
function hasCommand(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_GO = hasCommand('go', ['version']);

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'gnomon-refimpl-'));

  // Exercises keygen.mjs too -- an integrator's very first step, and the one
  // that decides whether we ever see a private key by accident.
  execFileSync('node', [join(NODE_DIR, 'keygen.mjs'), '--out', workDir, '--kid', KID], {
    stdio: 'pipe',
  });

  privateKeyPath = join(workDir, `${KID}.private.pem`);

  registry = new InMemoryKeyRegistry();
  await registerSpkiKey(registry, {
    kid: KID,
    tenantId: TENANT,
    spki: readFileSync(join(workDir, `${KID}.public.pem`), 'utf8'),
  });
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const MINT_ARGS = [
  '--kid', KID,
  '--tenant', TENANT,
  '--subject', 'resident-42',
  '--calendars', `${CAL_A},${CAL_B}`,
  '--scopes', 'events:read',
];

function mintWithNode(extra: string[] = []): string {
  return execFileSync(
    'node',
    [join(NODE_DIR, 'mint.mjs'), '--key', privateKeyPath, ...MINT_ARGS, ...extra],
    { encoding: 'utf8' },
  ).trim();
}

function mintWithGo(extra: string[] = []): string {
  return execFileSync(
    'go',
    ['run', 'mint.go', '--key', privateKeyPath, ...MINT_ARGS, ...extra],
    { cwd: GO_DIR, encoding: 'utf8' },
  ).trim();
}

const decodeSegment = (token: string, index: number) =>
  JSON.parse(new TextDecoder().decode(base64url.decode(token.split('.')[index] as string)));

describe('keygen.mjs', () => {
  it('writes a PKCS#8 private key and an SPKI public key', () => {
    expect(readFileSync(privateKeyPath, 'utf8')).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(readFileSync(join(workDir, `${KID}.public.pem`), 'utf8')).toMatch(
      /^-----BEGIN PUBLIC KEY-----/,
    );
  });

  it('produces a public key the server accepts at registration', async () => {
    // Registration refuses private keys and non-Ed25519 keys, so a successful
    // registration in beforeAll already proves the generated key is the right
    // kind. This asserts the pairing explicitly.
    await expect(registry.findByKid(KID)).resolves.toMatchObject({ tenantId: TENANT });
  });
});

describe('Node reference implementation', () => {
  it('mints a token the real verifier accepts', async () => {
    const verified = await verifyToken(mintWithNode(), registry);

    expect(verified.tenantId).toBe(TENANT);
    expect(verified.subject).toBe('resident-42');
    expect(verified.calendarIds).toEqual([CAL_A, CAL_B]);
    expect(verified.scopes).toEqual(['events:read']);
  });

  it('defaults to a lifetime the server considers acceptable', async () => {
    // The default in the example must sit inside the server's maximum, or
    // every integrator who copies it verbatim is rejected on day one.
    const claims = decodeSegment(mintWithNode(), 1);
    expect(claims.exp - claims.iat).toBe(300);
    await expect(verifyToken(mintWithNode(), registry)).resolves.toBeDefined();
  });

  it('produces a token the server rejects when told to use a reckless TTL', async () => {
    // Proves the server's lifetime cap is reachable from the example, so the
    // guidance in its comments is enforced rather than merely advisory.
    const token = mintWithNode(['--ttl', '31536000']);
    await expect(verifyToken(token, registry)).rejects.toThrow(/excessive_lifetime/);
  });

  it('exits non-zero when a required argument is missing', () => {
    expect(() =>
      execFileSync('node', [join(NODE_DIR, 'mint.mjs'), '--key', privateKeyPath], { stdio: 'pipe' }),
    ).toThrow();
  });
});

describe.skipIf(!HAS_GO)('Go reference implementation', () => {
  it('mints a token the real verifier accepts', async () => {
    const verified = await verifyToken(mintWithGo(), registry);

    expect(verified.tenantId).toBe(TENANT);
    expect(verified.subject).toBe('resident-42');
    expect(verified.calendarIds).toEqual([CAL_A, CAL_B]);
    expect(verified.scopes).toEqual(['events:read']);
  }, 120_000);

  it('defaults to a lifetime the server considers acceptable', () => {
    const claims = decodeSegment(mintWithGo(), 1);
    expect(claims.exp - claims.iat).toBe(300);
  }, 120_000);

  it('exits non-zero when a required argument is missing', () => {
    expect(() =>
      execFileSync('go', ['run', 'mint.go', '--key', privateKeyPath], { cwd: GO_DIR, stdio: 'pipe' }),
    ).toThrow();
  }, 120_000);
});

describe.skipIf(!HAS_GO)('the two implementations agree', () => {
  it('emit identical headers', () => {
    // Divergence here means one of them was edited and the other was not.
    expect(decodeSegment(mintWithGo(), 0)).toEqual(decodeSegment(mintWithNode(), 0));
  }, 120_000);

  it('emit identical claims apart from the timestamps', () => {
    const strip = (claims: Record<string, unknown>) => {
      const { iat, exp, ...rest } = claims;
      return rest;
    };
    expect(strip(decodeSegment(mintWithGo(), 1))).toEqual(strip(decodeSegment(mintWithNode(), 1)));
  }, 120_000);

  it('both encode an empty calendar list as [] rather than null', () => {
    // Go marshals a nil slice as null, which would read as "no claim" rather
    // than "no calendars". Both grant nothing, but the contract says [].
    for (const token of [mintWithNode(['--calendars', '']), mintWithGo(['--calendars', ''])]) {
      expect(decodeSegment(token, 1).cal).toEqual([]);
    }
  }, 120_000);
});

describe('toolchain coverage', () => {
  it('actually ran the Go example rather than silently skipping it', () => {
    // A skipped example is an unverified example. Locally that is a warning;
    // in CI it is a failure, because CI is where the promise is kept.
    if (!HAS_GO && process.env.CI) {
      throw new Error(
        'Go is unavailable in CI, so the Go reference implementation was never verified. ' +
          'Install Go in the workflow or remove the example.',
      );
    }
    expect(HAS_GO || !process.env.CI).toBe(true);
  });
});
