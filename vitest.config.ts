import { defineConfig } from 'vitest/config';

/**
 * Root-level tests only. Workspace packages own their own configs and run
 * via `pnpm -r test`; this config covers the repo tooling in `scripts/`,
 * which belongs to no package but still has to be correct.
 */
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.mjs'],
  },
});
