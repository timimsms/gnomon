#!/usr/bin/env node
/**
 * License compliance gate (ADR-0002 / L2).
 *
 * Gnomon ships under MIT so that integrators can embed it without legal
 * review. A single copyleft dependency -- most plausibly a premium
 * calendar renderer under AGPLv3 -- would silently relicense the entire
 * project and destroy that guarantee.
 *
 * This runs in CI on every PR, before typecheck and tests. It is intended
 * to be annoying: adding a license to the allowlist should require an ADR,
 * not a one-line diff.
 *
 * The classification logic is exported and unit-tested against fixture
 * reports. A gate that has never been observed to reject anything is not a
 * gate -- a misparsed report would otherwise pass silently forever.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const ALLOWED = new Set([
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
export const ALLOWED_EXPRESSIONS = new Set([
  '(MIT OR Apache-2.0)',
  '(Apache-2.0 OR MIT)',
  '(MIT OR CC0-1.0)',
  '(BSD-3-Clause OR GPL-2.0)',
  '(MIT AND BSD-3-Clause)',
  '(MIT AND Zlib)',
]);

/** Packages exempted with a written reason. Keep this list at zero if possible. */
export const EXEMPTIONS = new Map();

/**
 * Classifies a `pnpm licenses list --json --long` report.
 *
 * Shape is `{ "<license>": [{ name, versions, ... }, ...] }`. Anything that
 * is not an allowed identifier or an allowed expression is a violation --
 * including licenses we have never seen, which is the point: an unknown
 * license fails closed.
 */
export function findViolations(report) {
  const violations = [];

  for (const [license, packages] of Object.entries(report)) {
    if (ALLOWED.has(license) || ALLOWED_EXPRESSIONS.has(license)) continue;

    for (const pkg of packages) {
      if (EXEMPTIONS.has(pkg.name)) continue;
      violations.push({ name: pkg.name, versions: pkg.versions ?? [], license });
    }
  }

  return violations;
}

export function countPackages(report) {
  return Object.values(report).reduce((n, list) => n + list.length, 0);
}

function readLicenses() {
  const raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--long'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function main(argv) {
  // `--report <path>` reads a saved report instead of shelling out, so the
  // gate can be exercised offline and against known-bad input.
  const reportFlag = argv.indexOf('--report');

  let report;
  try {
    report =
      reportFlag === -1
        ? readLicenses()
        : JSON.parse(readFileSync(argv[reportFlag + 1], 'utf8'));
  } catch (error) {
    // Exit 2, distinct from 1, so a parse or tooling failure is never
    // mistaken for a clean pass by a caller that only checks for zero.
    console.error('Could not read dependency licenses.');
    console.error(error instanceof Error ? error.message : error);
    return 2;
  }

  const violations = findViolations(report);

  if (violations.length === 0) {
    console.log(`License gate passed. ${countPackages(report)} packages, all permissive.`);
    return 0;
  }

  console.error('\nLicense gate FAILED. Disallowed licenses found:\n');
  for (const v of violations) {
    console.error(`  ${v.name}@${v.versions.join(',')} -- ${v.license}`);
  }
  console.error('\nGnomon is MIT licensed and must stay installable without legal review.');
  console.error(
    'If this dependency is genuinely necessary, open an ADR before touching the allowlist.\n',
  );
  return 1;
}

// Only run when invoked directly, so the module can be imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
