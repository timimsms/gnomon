#!/usr/bin/env node
/**
 * The loader size budget (phase 4.5).
 *
 * The target is "auditable in one sitting", and a byte count is the only
 * proxy for that which a machine can check. Budgets that merely warn are
 * ignored, so this fails the build -- the loader grows past 2KB one helpful
 * addition at a time, and each one looks reasonable on its own.
 *
 * If you are here because the build went red: the fix is almost never to
 * raise the number. It is to ask whether the thing you added belongs in the
 * component bundle instead, which has no budget because nobody pastes it
 * into their page by hand.
 */

import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BUDGET_GZIP_BYTES = 2048;

const bundle = fileURLToPath(new URL('../dist/embed.js', import.meta.url));

let raw;
try {
  raw = readFileSync(bundle);
} catch {
  console.error(`No bundle at ${bundle}. Run \`pnpm build\` first.`);
  process.exit(2);
}

// Maximum compression, because that is what a CDN will serve and anything
// less would let the budget pass on a technicality.
const gzipped = gzipSync(raw, { level: 9 }).length;
const percent = Math.round((gzipped / BUDGET_GZIP_BYTES) * 100);

console.log(
  `loader: ${statSync(bundle).size} B raw, ${gzipped} B gzipped ` +
    `(${percent}% of the ${BUDGET_GZIP_BYTES} B budget)`,
);

if (gzipped > BUDGET_GZIP_BYTES) {
  console.error(
    `\nLoader exceeds its size budget by ${gzipped - BUDGET_GZIP_BYTES} B gzipped.\n` +
      'This file is pasted into other people\'s pages and is meant to be readable\n' +
      'end to end. Prefer moving the addition into @gnomon/embed, which is loaded\n' +
      'on demand and has no budget.\n',
  );
  process.exit(1);
}

// A bundle that shrank to nothing would also pass a "less than" check, and
// would mean the build silently produced an empty file.
if (gzipped < 200) {
  console.error(`\nLoader is suspiciously small (${gzipped} B). Did the build emit anything?\n`);
  process.exit(1);
}
