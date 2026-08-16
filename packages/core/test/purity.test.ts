import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Architectural constraints that are otherwise only prose.
 *
 * ADR-0006 puts every Temporal import behind one module, and ADR-0008 keeps
 * `@gnomon/core`'s main entry free of Node builtins. Both hold today by
 * review, which is to say they hold until someone adds an import in a hurry.
 * Until a lint rule exists (deferred in phase 0), these tests are the
 * enforcement.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path),
  source: readFileSync(path, 'utf8'),
}));

/** Import specifiers, from both static imports and re-exports. */
function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
}

describe('core stays importable in a browser (ADR-0008)', () => {
  it('finds the source tree', () => {
    // Guards against the whole suite passing vacuously if the layout moves.
    expect(files.length).toBeGreaterThan(4);
  });

  it('imports no Node builtins outside the ics subpath', () => {
    const offenders = files
      .filter((file) => !file.path.startsWith('ics'))
      .flatMap((file) =>
        importsOf(file.source)
          .filter((spec) => spec.startsWith('node:'))
          .map((spec) => `${file.path} imports ${spec}`),
      );

    expect(offenders).toEqual([]);
  });

  it('imports node-ical only from the ics subpath', () => {
    // node-ical's entry pulls node:fs, so a single import of it from the main
    // graph puts fs in every browser bundle.
    const offenders = files
      .filter((file) => !file.path.startsWith('ics'))
      .filter((file) => importsOf(file.source).includes('node-ical'))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('does not re-export the ics subpath from the main entry', () => {
    expect(importsOf(readFileSync(join(SRC, 'index.ts'), 'utf8'))).not.toContain('./ics/index.js');
  });
});

describe('Temporal is acquired in exactly one place (ADR-0006)', () => {
  it('is imported from temporal-polyfill only by temporal.ts', () => {
    const offenders = files
      .filter((file) => file.path !== 'temporal.ts')
      .filter((file) => importsOf(file.source).includes('temporal-polyfill'))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('has a chokepoint that actually re-exports Temporal', () => {
    // Without this, the test above would pass just as well if temporal.ts
    // were deleted and nothing imported Temporal at all.
    const chokepoint = files.find((file) => file.path === 'temporal.ts');
    expect(chokepoint?.source).toMatch(/export\s*\{\s*Temporal\s*\}\s*from\s*'temporal-polyfill'/);
  });
});
