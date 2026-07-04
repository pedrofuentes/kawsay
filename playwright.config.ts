import { defineConfig } from '@playwright/test';

// End-to-end config for the renderer-egress AC-4 proof (issue #40, §6.2). The
// suite drives the BUILT Electron app via Playwright's Electron support
// (`_electron`), which uses the `electron` binary from node_modules and the
// project's own Chromium — so NO `playwright install` / browser download is
// needed. Run with `pnpm test:e2e` (build `out/` first: `pnpm build`).
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  // One worker: the spec launches a real Electron process and asserts on a shared
  // window, so serial execution keeps the run deterministic.
  workers: 1,
  reporter: process.env['CI'] ? 'github' : 'list',
  // Electron launch + first-window load is heavier than a bare browser page.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    trace: 'on-first-retry',
  },
  // A single Electron project. Tests call `_electron.launch()` directly, so no
  // browser `use: { browserName }` is set and no browser binary is downloaded.
  projects: [{ name: 'electron' }],
});
