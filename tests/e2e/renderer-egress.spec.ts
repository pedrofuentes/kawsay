/**
 * AC-4 renderer-egress proof (issue #40, §6.2 defense-in-depth layer).
 *
 * The authoritative zero-network-egress guarantee (MISSION §5 / PRD AC-4) is
 * enforced by an OS-level outbound DENY (`.github/workflows/ac4-egress.yml`) and
 * the in-process guard + CSP (`electron/main/security/{network-guard,csp}.ts`).
 * This spec adds the missing renderer-stack layer: it drives the REAL, built
 * Electron/Chromium app through Playwright and proves the renderer cannot reach
 * the network — every outbound attempt (fetch / WebSocket / <img>) is blocked and
 * NOT a single external request is dispatched off the machine.
 *
 * It is a coverage test that LOCKS existing correct behavior, so it must genuinely
 * discriminate: it first asserts the packaged renderer actually loaded (a blank or
 * failed page trivially "makes no requests"), then asserts each egress attempt is
 * refused by the app's OWN Content-Security-Policy (`connect-src 'none'`,
 * `img-src 'self' data:`). If any control regressed so the renderer COULD egress,
 * these assertions fail.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

// The built main-process entry the packaged app boots from (package.json "main").
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const mainEntry = fileURLToPath(new URL('../../out/main/index.js', import.meta.url));

// A routable public endpoint that WOULD answer if the renderer could egress, so a
// blocked attempt proves an active control — not a closed port — stops it. Mirrors
// KAWSAY_AC4_PUBLIC_HOST in the OS-deny jobs.
const EXTERNAL_HTTP = 'http://1.1.1.1/';
const EXTERNAL_WS = 'ws://1.1.1.1/';
const EXTERNAL_IMG = 'http://1.1.1.1/kawsay-egress-probe.png';

/** Loopback hosts that never leave the machine (dev-server carve-out in the guard). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
/** Schemes that reach the network; a packaged renderer speaks only `file:`/`data:`. */
const REMOTE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:']);

/** True iff a URL denotes real off-machine egress (any remote-scheme, non-loopback host). */
function isExternalEgress(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  return REMOTE_SCHEMES.has(parsed.protocol) && !LOOPBACK_HOSTS.has(parsed.hostname);
}

/**
 * Launch the built app EXACTLY as a packaged run would resolve the renderer:
 * with `ELECTRON_RENDERER_URL` unset, `electron/main/index.ts` falls to
 * `loadFile(rendererEntryPath)` and installs the PRODUCTION CSP (`connect-src
 * 'none'`) — no source change is needed to force prod behaviour under test.
 */
function packagedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // electron-vite sets this only under `dev`; unsetting it selects the file://
  // renderer + production CSP, the packaged code path we want to prove.
  delete env['ELECTRON_RENDERER_URL'];
  return env;
}

/** The outcome + the CSP directive (if any) that a renderer egress probe reported. */
interface ProbeResult {
  readonly outcome: string;
  readonly directive: string | null;
}

test.describe.serial('AC-4 renderer network egress is blocked', () => {
  let app: ElectronApplication;
  let page: Page;
  // Requests that reached Chromium's network layer / completed, bucketed to external
  // egress — both MUST stay empty (nothing leaves the machine).
  const externalDispatched: string[] = [];
  const externalFinished: string[] = [];

  test.beforeAll(async () => {
    // A throwaway, per-run user-data dir keeps the probe hermetic and never touches
    // a developer's real Kawsay data. It lives under the git-ignored test-results/.
    mkdirSync(`${projectRoot}test-results`, { recursive: true });
    const userDataDir = mkdtempSync(`${projectRoot}test-results/electron-user-data-`);

    app = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: packagedEnv(),
    });
    page = await app.firstWindow();

    // Observe the network at the dispatch layer: any external request that reaches
    // here is real egress, so record it AND abort it (belt-and-suspenders: the test
    // itself never lets a byte leave, even if an app-side control had regressed).
    // Local file:// app resources continue untouched.
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (isExternalEgress(url)) {
        externalDispatched.push(url);
        await route.abort();
        return;
      }
      await route.continue();
    });
    page.on('requestfinished', (request) => {
      const url = request.url();
      if (isExternalEgress(url)) externalFinished.push(url);
    });
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('loads the packaged renderer over file:// (a live app, not a blank page)', async () => {
    // Discrimination guard: prove we are testing a REAL, mounted renderer. A blank
    // or failed page would make zero requests and pass the egress asserts vacuously.
    await expect(page).toHaveTitle('Kawsay');
    expect(page.url()).toMatch(/^file:\/\/.*\/out\/renderer\/index\.html$/u);
    await expect(page.locator('main')).toBeVisible();
    const rootHtml = await page.locator('#root').innerHTML();
    expect(rootHtml.length).toBeGreaterThan(0);
  });

  test('refuses fetch(), WebSocket and <img> to an external host, dispatching nothing', async () => {
    // fetch(): the promise MUST reject (a live egress would RESOLVE with a status),
    // and the CSP `connect-src` directive is what refuses it.
    const fetchResult = await page.evaluate(
      (target): Promise<ProbeResult> =>
        new Promise((resolve) => {
          let directive: string | null = null;
          document.addEventListener(
            'securitypolicyviolation',
            (event) => {
              directive = event.violatedDirective;
            },
            { once: true },
          );
          fetch(target)
            .then((res) => resolve({ outcome: `RESOLVED ${res.status}`, directive }))
            // Defer so the synchronous CSP violation is captured before we settle.
            .catch(() => setTimeout(() => resolve({ outcome: 'REJECTED', directive }), 0));
        }),
      EXTERNAL_HTTP,
    );
    console.log('[ac4] fetch ->', JSON.stringify(fetchResult));
    expect(fetchResult.outcome).toBe('REJECTED');
    expect(fetchResult.directive ?? '').toContain('connect-src');

    // WebSocket: it MUST never open (a live egress fires `onopen`); CSP `connect-src`
    // refuses the handshake, surfacing as an error/close.
    const wsResult = await page.evaluate(
      (target): Promise<ProbeResult> =>
        new Promise((resolve) => {
          let directive: string | null = null;
          document.addEventListener(
            'securitypolicyviolation',
            (event) => {
              directive = event.violatedDirective;
            },
            { once: true },
          );
          let socket: WebSocket;
          try {
            socket = new WebSocket(target);
          } catch {
            resolve({ outcome: 'THREW', directive });
            return;
          }
          const settle = (outcome: string): void => resolve({ outcome, directive });
          const timer = setTimeout(() => settle('TIMEOUT'), 5000);
          socket.onopen = (): void => {
            clearTimeout(timer);
            settle('OPENED');
          };
          socket.onerror = (): void => {
            clearTimeout(timer);
            setTimeout(() => settle('ERROR'), 0);
          };
          socket.onclose = (): void => {
            clearTimeout(timer);
            settle('CLOSED');
          };
        }),
      EXTERNAL_WS,
    );
    console.log('[ac4] websocket ->', JSON.stringify(wsResult));
    expect(wsResult.outcome).not.toBe('OPENED');
    expect(wsResult.directive ?? '').toContain('connect-src');

    // <img>: it MUST never load (a live egress fires `onload`); CSP `img-src` refuses it.
    const imgResult = await page.evaluate(
      (target): Promise<ProbeResult> =>
        new Promise((resolve) => {
          let directive: string | null = null;
          document.addEventListener(
            'securitypolicyviolation',
            (event) => {
              directive = event.violatedDirective;
            },
            { once: true },
          );
          const image = new Image();
          const timer = setTimeout(() => resolve({ outcome: 'TIMEOUT', directive }), 5000);
          image.onload = (): void => {
            clearTimeout(timer);
            resolve({ outcome: 'LOADED', directive });
          };
          image.onerror = (): void => {
            clearTimeout(timer);
            setTimeout(() => resolve({ outcome: 'ERROR', directive }), 0);
          };
          image.src = target;
        }),
      EXTERNAL_IMG,
    );
    console.log('[ac4] img ->', JSON.stringify(imgResult));
    expect(imgResult.outcome).not.toBe('LOADED');
    expect(imgResult.directive ?? '').toContain('img-src');

    // Let any late network event flush, then assert the strongest guarantee: NOT ONE
    // external request was dispatched to — or completed on — the network. If a control
    // regressed, the blocked request would surface here and fail the run.
    await page.waitForTimeout(250);
    console.log('[ac4] external dispatched ->', JSON.stringify(externalDispatched));
    console.log('[ac4] external finished ->', JSON.stringify(externalFinished));
    expect(externalDispatched).toEqual([]);
    expect(externalFinished).toEqual([]);
  });
});
