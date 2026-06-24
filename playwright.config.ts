import { defineConfig } from '@playwright/test';

// Skeleton Playwright config for end-to-end tests that drive the packaged
// Electron app via Playwright's Electron support (`_electron`). The full e2e
// suite (launch smoke, AC harness) is wired in later cards; this establishes
// the runner and conventions so `pnpm exec playwright test` is ready to grow.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    trace: 'on-first-retry',
  },
});
