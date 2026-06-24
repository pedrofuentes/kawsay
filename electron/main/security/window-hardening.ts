import { realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The hardened `webPreferences` for the single BrowserWindow (ARCHITECTURE
 * §2.1). These are the security-critical defaults the renderer sandbox depends
 * on; they must never be overridden.
 */
export interface SecureWebPreferences {
  readonly contextIsolation: true;
  readonly sandbox: true;
  readonly nodeIntegration: false;
  readonly nodeIntegrationInWorker: false;
  readonly nodeIntegrationInSubFrames: false;
  readonly webSecurity: true;
  readonly preload: string;
  readonly devTools: boolean;
}

/** Construct the hardened webPreferences. `devTools` is the only knob — enabled
 *  for dev builds, disabled in the packaged app. */
export function buildSecureWebPreferences(
  preloadPath: string,
  options: { readonly devTools: boolean },
): SecureWebPreferences {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    preload: preloadPath,
    devTools: options.devTools,
  };
}

/** Structural view of `webContents` for navigation hardening, so this module
 *  unit-tests without an Electron runtime. */
export type WillNavigateListener = (event: { preventDefault: () => void }, url: string) => void;
export interface NavigationHardenableWebContents {
  on(event: 'will-navigate', listener: WillNavigateListener): void;
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: 'deny' } | { action: 'allow' },
  ): void;
  getURL(): string;
}

/** The explicit navigation allowlist. Anything not on it is blocked — including
 *  every other `file://` document and all opaque-origin schemes. */
export interface NavigationHardeningOptions {
  /** The packaged renderer entry — the ONLY `file://` document navigable. */
  readonly appEntryUrl: string;
  /** In development, the dev-server URL whose origin is also navigable. Absent
   *  in production. */
  readonly devServerUrl?: string | undefined;
  /** Platform whose path semantics govern the `file://` comparison. Defaults to
   *  the host platform (`process.platform`); injectable so the Windows path
   *  identity is testable on POSIX hosts and on CI. On `win32` paths are
   *  compared case-insensitively (the NTFS reality); on POSIX, case-sensitively. */
  readonly platform?: NodeJS.Platform | undefined;
}

/**
 * Deny every `window.open` / `target=_blank`, and allow navigation ONLY to the
 * explicit renderer allowlist (ARCHITECTURE §2.1): the exact app entry, plus the
 * dev-server origin in development. Navigation is denied by default, so any
 * other `file://` path, the opaque-origin schemes (`data:`, `about:`,
 * `javascript:`, `blob:`) and every remote origin are blocked. We never compare
 * `.origin` for `file://` URLs, because every `file://` URL shares the same
 * opaque (`'null'`) origin — the bug this guard replaces.
 */
export function applyNavigationHardening(
  webContents: NavigationHardenableWebContents,
  options: NavigationHardeningOptions,
): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, options)) {
      event.preventDefault();
    }
  });
}

const OPAQUE_NAVIGATION_SCHEMES: ReadonlySet<string> = new Set([
  'data:',
  'about:',
  'javascript:',
  'blob:',
]);

function isAllowedNavigation(candidate: string, options: NavigationHardeningOptions): boolean {
  const target = tryParseUrl(candidate);
  if (target === null) {
    return false;
  }
  if (target.protocol === 'file:') {
    return isAppEntry(target, options.appEntryUrl, options.platform ?? process.platform);
  }
  if (OPAQUE_NAVIGATION_SCHEMES.has(target.protocol)) {
    return false;
  }
  if (options.devServerUrl !== undefined) {
    const devServer = tryParseUrl(options.devServerUrl);
    return devServer !== null && target.origin === devServer.origin;
  }
  return false;
}

/** True only when `target` is exactly the packaged renderer entry file. Its
 *  hash/query (e.g. SPA client routes) are ignored; any other path is denied.
 *  Both sides are reduced to canonical real paths under the active platform's
 *  semantics, so `file:///C:/app/...` matches the `C:\app\...` entry on Windows
 *  without ever allowing a distinct path. */
function isAppEntry(target: URL, appEntryUrl: string, platform: NodeJS.Platform): boolean {
  const entry = tryParseUrl(appEntryUrl);
  if (entry === null || entry.protocol !== 'file:') {
    return false;
  }
  return samePath(canonicalPath(target, platform), canonicalPath(entry, platform), platform);
}

/** Resolve a `file://` URL to a canonical real path (symlinks/`..` collapsed)
 *  for an exact comparison. `fileURLToPath` decodes percent-escapes and maps
 *  `file:///C:/…` → `C:\…` on Windows; an unconvertible URL yields `null` so it
 *  can never match (fail-closed). The realpath-failure fallback normalises
 *  lexically in the platform's flavour, symmetrically for both candidates. */
function canonicalPath(url: URL, platform: NodeJS.Platform): string | null {
  let filePath: string;
  try {
    filePath = fileURLToPath(url, { windows: platform === 'win32' });
  } catch {
    return null;
  }
  const platformPath = platform === 'win32' ? win32 : posix;
  try {
    return platformPath.normalize(realpathSync.native(filePath));
  } catch {
    return platformPath.normalize(filePath);
  }
}

/** Path identity under the active platform: case-insensitive on Windows (the
 *  NTFS reality, drive letter included), case-sensitive on POSIX. A `null`
 *  (unconvertible) path never matches. */
function samePath(a: string | null, b: string | null, platform: NodeJS.Platform): boolean {
  if (a === null || b === null) {
    return false;
  }
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
