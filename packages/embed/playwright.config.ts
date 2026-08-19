import { defineConfig } from '@playwright/test';

/**
 * The adapter conformance suite runs in a real browser.
 *
 * jsdom and friends were not considered: both renderers measure layout, and a
 * DOM that does not lay out would let an adapter pass while drawing nothing.
 */
export default defineConfig({
  testDir: './test',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: { baseURL: 'http://127.0.0.1:5178' },
  webServer: {
    // Bind explicitly: Vite defaults to localhost, which resolves to ::1 here,
    // and Playwright's 127.0.0.1 health check then never connects.
    command: 'vite --host 127.0.0.1 --port 5178 --strictPort test/fixture',
    url: 'http://127.0.0.1:5178',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
