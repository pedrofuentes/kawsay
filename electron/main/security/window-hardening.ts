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

/**
 * Deny every `window.open` / `target=_blank` and block navigation away from the
 * app's own origin (ARCHITECTURE §2.1). v1 opens no external links, so the only
 * legitimate navigation is within the app origin itself.
 */
export function applyNavigationHardening(webContents: NavigationHardenableWebContents): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (event, url) => {
    if (!isSameOrigin(url, webContents.getURL())) {
      event.preventDefault();
    }
  });
}

function isSameOrigin(candidate: string, current: string): boolean {
  try {
    return new URL(candidate).origin === new URL(current).origin;
  } catch {
    return false;
  }
}
