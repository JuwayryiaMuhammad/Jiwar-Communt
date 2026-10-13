import { defineConfig, devices } from 'playwright/test';

/**
 * Browser smoke of the built app against a seeded local API
 * (test/web-smoke/serve.web-smoke.ts). Local only, never in CI. The version
 * of playwright is pinned to the Chromium build already on the
 * machine, so nothing is downloaded.
 *
 *   WEB_SMOKE_DIR  where the API wrote seed.json
 *   WEB_SMOKE_PORT the port this app listens on (default 3193)
 */
const port = Number(process.env.WEB_SMOKE_PORT ?? 3193);
const api = process.env.WEB_SMOKE_API_URL ?? 'http://127.0.0.1:3190';

export default defineConfig({
  testDir: '.',
  outputDir: process.env.WEB_SMOKE_DIR ? `${process.env.WEB_SMOKE_DIR}/playwright` : './.results',
  // One API, one mailbox, links that work once: in order, one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // A small Android phone.
    ...devices['Galaxy S8'],
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  webServer: {
    // The production build: its Content-Security-Policy is the strict one.
    command: `pnpm exec next start --hostname 127.0.0.1 --port ${port}`,
    cwd: '..',
    url: `http://127.0.0.1:${port}/`,
    env: { JIWAR_API_URL: api },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
