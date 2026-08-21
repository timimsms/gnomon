import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// Written by scripts/setup-e2e.ts, which must run first -- Playwright starts
// webServer BEFORE globalSetup, so the database cannot be created there.
const envFile = fileURLToPath(new URL('./.e2e-env.json', import.meta.url));
const { databaseUrl } = JSON.parse(readFileSync(envFile, 'utf8')) as { databaseUrl: string };

// Absolute: `pnpm --filter` runs the command in the PACKAGE directory, so a
// path relative to the repo root resolves somewhere else entirely.
const DEMO_KEY = fileURLToPath(new URL('../server/.demo-key.pem', import.meta.url));

const GNOMON_PORT = 3100;
const PORTAL_PORT = 4100;

/**
 * The hostile-host suite runs against TWO real servers on TWO origins.
 *
 * Different ports means a genuinely different origin, which is the whole
 * point: every cross-origin hazard -- CORS, the iframe boundary, postMessage
 * -- only exists because Gnomon and the portal are not the same site. A
 * single-origin fixture would pass while the product was broken.
 */
export default defineConfig({
  testDir: './test',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'line' : 'list',
  use: { baseURL: `http://127.0.0.1:${PORTAL_PORT}` },
  webServer: [
    {
      command: `pnpm --filter @gnomon/server exec tsx src/index.ts`,
      url: `http://127.0.0.1:${GNOMON_PORT}/health`,
      cwd: '../..',
      env: {
        PORT: String(GNOMON_PORT),
        DATABASE_URL: databaseUrl,
      },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
    },
    {
      command: `pnpm --filter @gnomon/demo-portal exec tsx src/server.ts`,
      url: `http://127.0.0.1:${PORTAL_PORT}/`,
      cwd: '../..',
      env: {
        PORT: String(PORTAL_PORT),
        GNOMON_ORIGIN: `http://127.0.0.1:${GNOMON_PORT}`,
        DATABASE_URL: databaseUrl,
        DEMO_KEY,
      },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
    },
  ],
});
