#!/usr/bin/env node
/**
 * License compliance gate (ADR-0002 / L2).
 *
 * Gnomon ships under MIT so that integrators can embed it without legal
 * review. A single copyleft dependency -- most plausibly a premium
 * calendar renderer under AGPLv3 -- would silently relicense the entire
 * project and destroy that guarantee.
 *
 * This runs in CI on every PR. It is intended to be annoying: adding a
 * license to the allowlist should require an ADR, not a one-line diff.
 */

import { execFileSync } from 'node:child_process';

const ALLOWED = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'Python-2.0',
  'MIT-0',
]);

/**
 * SPDX expressions we accept wholesale because every disjunct is allowed.
 * Kept explicit rather than parsed -- a real SPDX expression parser is
 * more surface area than this gate deserves.
 */
const ALLOWED_EXPRESSIONS = new Set([
  '(MIT OR Apache-2.0)',
  '(Apache-2.0 OR MIT)',
  '(MIT OR CC0-1.0)',
  '(BSD-3-Clause OR GPL-2.0)',
  '(MIT AND BSD-3-Clause)',
  '(MIT AND Zlib)',
]);

/** Packages exempted with a written reason. Keep this list at zero if possible. */
const EXEMPTIONS = new Map();

function readLicenses() {
  const raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--long'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function main() {
  let report;
  try {
    report = readLicenses();
  } catch (error) {
    console.error('Could not read dependency licenses.');
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }

  const violations = [];

  for (const [license, packages] of Object.entries(report)) {
    if (ALLOWED.has(license) || ALLOWED_EXPRESSIONS.has(license)) continue;

    for (const pkg of packages) {
      if (EXEMPTIONS.has(pkg.name)) continue;
      violations.push({ name: pkg.name, versions: pkg.versions ?? [], license });
    }
  }

  if (violations.length === 0) {
    const count = Object.values(report).reduce((n, list) => n + list.length, 0);
    console.log(`License gate passed. ${count} packages, all permissive.`);
    return;
  }

  console.error('\nLicense gate FAILED. Disallowed licenses found:\n');
  for (const v of violations) {
    console.error(`  ${v.name}@${v.versions.join(',')} -- ${v.license}`);
  }
  console.error(
    '\nGnomon is MIT licensed and must stay installable without legal review.',
  );
  console.error(
    'If this dependency is genuinely necessary, open an ADR before touching the allowlist.\n',
  );
  process.exit(1);
}

main();
