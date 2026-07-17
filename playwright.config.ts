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
  // In CI, pair the inline GitHub annotations with the HTML reporter so a failed
  // run ships a browsable `playwright-report/` (embedding the on-first-retry trace
  // + only-on-failure screenshot) as an uploadable artifact (#445). `open: 'never'`
  // keeps it from trying to spawn a browser on the headless runner.
  reporter: process.env['CI']
    ? [['github'], ['html', { open: 'never' }]]
    : 'list',
  // Electron launch + first-window load is heavier than a bare browser page.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    trace: 'on-first-retry',
    // Keep a screenshot of the exact failing state so a red CI run ships a visual
    // artifact alongside the trace (#445). No cost on green runs.
    screenshot: 'only-on-failure',
  },
  // A single Electron project. Tests call `_electron.launch()` directly, so no
  // browser `use: { browserName }` is set and no browser binary is downloaded.
  projects: [{ name: 'electron' }],
});
