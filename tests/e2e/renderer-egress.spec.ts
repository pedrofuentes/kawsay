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
 * `img-src 'self' data: kawsay-media:`). The only local-media allowances (#428) are
 * the non-networked `kawsay-media:` scheme on `img-src`/`media-src`; the egress floor
 * (`default-src`/`connect-src 'none'`) is untouched, so an external fetch/img/ws is
 * still refused. If any control regressed so the renderer COULD egress, these fail.
 *
 * Two properties keep it honest:
 *   - Boot-time coverage (#291): egress is observed at the BrowserContext level with
 *     the listeners attached BEFORE the first window navigates, and a deterministic
 *     re-navigation replays the full `index.html` request graph under those active
 *     observers — so a remote resource pulled during the INITIAL load (a future
 *     regression relaxing a non-fetch/img CSP directive such as `script-src` or
 *     `font-src`) is caught, not missed in the gap before a page-level hook attaches.
 *   - A committed positive control (#292): a `data:` image DOES load under the same
 *     launch + CSP, proving the "image blocked" assertions are not vacuously true.
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
  // Belt-and-suspenders backstops. In this app the in-process network guard cancels
  // every remote request BEFORE Playwright's Fetch/route interception sees it (a
  // renderer egress surfaces as `net::ERR_BLOCKED_BY_CLIENT`), so these stay empty
  // unless BOTH the CSP and that guard regressed — they are the last-line failsafe,
  // not the primary renderer-egress signal (see `observedRequests`).
  const externalDispatched: string[] = [];
  const externalFinished: string[] = [];
  // PRIMARY renderer-egress signal (#291): every request the renderer ISSUED from
  // boot onward. `context.on('request')` (requestWillBeSent) fires for ANY request
  // the renderer makes — including a remote one a downstream control then blocks —
  // so it catches an off-machine reference in the boot graph that the network-
  // dispatch backstops above never observe.
  const observedRequests: string[] = [];

  test.beforeAll(async () => {
    // A throwaway, per-run user-data dir keeps the probe hermetic and never touches
    // a developer's real Kawsay data. It lives under the git-ignored test-results/.
    mkdirSync(`${projectRoot}test-results`, { recursive: true });
    const userDataDir = mkdtempSync(`${projectRoot}test-results/electron-user-data-`);

    app = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: packagedEnv(),
    });

    // #291: observe egress at the BrowserContext level and attach BEFORE the first
    // window navigates, so the INITIAL `index.html` load is covered too. The
    // `context.on('request')` listener attaches synchronously (no protocol
    // round-trip) and records EVERY request the renderer issues from boot onward,
    // including a remote one a downstream control then blocks — closing the gap the
    // old page-level hooks left between first-window resolution and registration.
    const context = app.context();
    context.on('request', (request) => {
      observedRequests.push(request.url());
    });
    context.on('requestfinished', (request) => {
      const url = request.url();
      if (isExternalEgress(url)) externalFinished.push(url);
    });
    // Last-line failsafe at the network-dispatch layer: if BOTH the CSP and the
    // app's own network guard ever regressed, an external request would reach the
    // route handler — record it AND abort it so the test process itself still never
    // lets a byte leave. Local `file://` app resources continue untouched. (Healthy,
    // the network guard cancels remote requests upstream, so this never fires — it
    // is a backstop, not the primary check; see `observedRequests`.)
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (isExternalEgress(url)) {
        externalDispatched.push(url);
        await route.abort();
        return;
      }
      await route.continue();
    });

    page = await app.firstWindow();
    await page.waitForLoadState('load');
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

  test('loads a data: image under the same CSP (positive control — egress asserts are not vacuous)', async () => {
    // #292 item 1: prove the <img> pipeline WORKS under the identical launch +
    // production CSP (`img-src 'self' data:`), so the "external <img> blocked"
    // assertion below is a real refusal — not an image path that never loads
    // anything. A 1x1 PNG data: URL is permitted by `data:` and MUST load.
    const dataUri =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const outcome = await page.evaluate(
      (src): Promise<string> =>
        new Promise((resolve) => {
          const image = new Image();
          const timer = setTimeout(() => resolve('TIMEOUT'), 5000);
          image.onload = (): void => {
            clearTimeout(timer);
            resolve('LOADED');
          };
          image.onerror = (): void => {
            clearTimeout(timer);
            resolve('ERROR');
          };
          image.src = src;
        }),
      dataUri,
    );
    console.log('[ac4] data-image positive control ->', outcome);
    expect(outcome).toBe('LOADED');
  });

  test('issues zero external requests across the full boot navigation (boot-time egress coverage)', async () => {
    // #291: prove the renderer makes NO off-machine request across its ENTIRE
    // lifetime, the INITIAL index.html load included — not just after a page-level
    // hook could attach. The context observer (live from before the first window
    // navigated) recorded every request since boot; re-navigating deterministically
    // replays the full index.html request graph under it, so a boot-time regression
    // (a relaxed non-fetch/img CSP directive pulling a remote script / font / etc.
    // during index.html load) is caught here — even though a downstream control
    // would still block the byte, the renderer must never even ASK.
    const seenBefore = observedRequests.length;
    await page.reload({ waitUntil: 'load' });
    await expect(page).toHaveTitle('Kawsay');
    await page.waitForTimeout(250);
    // The re-navigation re-requested the root document itself — proof the observer
    // is live for a COMPLETE navigation, initial load included, not merely
    // post-load activity (a blank/failed reload would trivially observe nothing).
    const replay = observedRequests.slice(seenBefore);
    console.log('[ac4] boot-nav replay ->', JSON.stringify(replay));
    expect(replay.some((url) => /\/out\/renderer\/index\.html$/u.test(url))).toBe(true);
    // From launch THROUGH this re-navigation, NOT ONE external request was issued by
    // the renderer — the strong boot-time guarantee.
    const externalObserved = observedRequests.filter((url) => isExternalEgress(url));
    console.log('[ac4] external observed (boot) ->', JSON.stringify(externalObserved));
    expect(externalObserved).toEqual([]);
    // Backstops: nothing reached the network-dispatch layer or completed off-machine.
    expect(externalDispatched).toEqual([]);
    expect(externalFinished).toEqual([]);
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
