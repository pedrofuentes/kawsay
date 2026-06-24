import { describe, expect, it } from 'vitest';
import {
  applyNavigationHardening,
  buildSecureWebPreferences,
  type NavigationHardenableWebContents,
  type WillNavigateListener,
} from '../../electron/main/security/window-hardening';

describe('buildSecureWebPreferences (BrowserWindow hardening, ARCHITECTURE §2.1)', () => {
  it('enforces the non-negotiable sandbox + isolation flags', () => {
    const prefs = buildSecureWebPreferences('/app/out/preload/index.cjs', { devTools: false });
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.nodeIntegrationInWorker).toBe(false);
    expect(prefs.nodeIntegrationInSubFrames).toBe(false);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.preload).toBe('/app/out/preload/index.cjs');
  });

  it('only enables devTools when explicitly asked (dev builds)', () => {
    expect(buildSecureWebPreferences('/p', { devTools: false }).devTools).toBe(false);
    expect(buildSecureWebPreferences('/p', { devTools: true }).devTools).toBe(true);
  });
});

function fakeWebContents(currentUrl: string) {
  let willNavigate: WillNavigateListener | undefined;
  const wc: NavigationHardenableWebContents & {
    fireWillNavigate: (url: string) => boolean;
    openHandler?: (details: { url: string }) => { action: 'deny' | 'allow' };
  } = {
    on(event, listener) {
      if (event === 'will-navigate') willNavigate = listener;
    },
    setWindowOpenHandler(handler) {
      wc.openHandler = handler;
    },
    getURL() {
      return currentUrl;
    },
    fireWillNavigate(url: string) {
      let prevented = false;
      willNavigate?.({ preventDefault: () => (prevented = true) }, url);
      return prevented;
    },
  };
  return wc;
}

describe('applyNavigationHardening (navigation + window.open lockdown, ARCHITECTURE §2.1)', () => {
  const appEntryUrl = 'file:///app/out/renderer/index.html';
  // POSIX, case-sensitive fixtures — pin the platform so the file:// comparison
  // runs under POSIX semantics on any host, including the Windows CI runner.
  const platform = 'darwin' as const;

  it('denies every window.open / target=_blank attempt', () => {
    const wc = fakeWebContents(appEntryUrl);
    applyNavigationHardening(wc, { appEntryUrl, platform });
    expect(wc.openHandler?.({ url: 'https://example.com' })).toEqual({ action: 'deny' });
  });

  it('allows navigation to the exact app entry', () => {
    const wc = fakeWebContents(appEntryUrl);
    applyNavigationHardening(wc, { appEntryUrl, platform });
    expect(wc.fireWillNavigate(appEntryUrl)).toBe(false);
  });

  it('blocks navigation to an unrelated local file (opaque file:// origin)', () => {
    const wc = fakeWebContents(appEntryUrl);
    applyNavigationHardening(wc, { appEntryUrl, platform });
    expect(wc.fireWillNavigate('file:///etc/passwd')).toBe(true);
  });

  it('blocks a sibling file in the app directory that is not the entry', () => {
    const wc = fakeWebContents(appEntryUrl);
    applyNavigationHardening(wc, { appEntryUrl, platform });
    expect(wc.fireWillNavigate('file:///app/out/renderer/other.html')).toBe(true);
  });

  it('blocks data:, about: and javascript: navigations (opaque origins)', () => {
    const wc = fakeWebContents(appEntryUrl);
    applyNavigationHardening(wc, { appEntryUrl, platform });
    expect(wc.fireWillNavigate('data:text/html,<script>alert(1)</script>')).toBe(true);
    expect(wc.fireWillNavigate('about:blank')).toBe(true);
    expect(wc.fireWillNavigate('javascript:alert(1)')).toBe(true);
  });

  it('blocks remote origins', () => {
    const wc = fakeWebContents(appEntryUrl);
    applyNavigationHardening(wc, { appEntryUrl, platform });
    expect(wc.fireWillNavigate('https://evil.example/phish')).toBe(true);
  });

  it('allows the dev-server origin ONLY when a dev server is configured', () => {
    const devServerUrl = 'http://localhost:5173';
    const wc = fakeWebContents(appEntryUrl);
    applyNavigationHardening(wc, { appEntryUrl, devServerUrl, platform });
    expect(wc.fireWillNavigate('http://localhost:5173/any/route')).toBe(false);
    // A foreign origin is still blocked, even in development.
    expect(wc.fireWillNavigate('http://localhost:4444/')).toBe(true);
  });
});

describe('applyNavigationHardening — Windows app entry (case-insensitive FS, issue #34)', () => {
  // The packaged Windows entry is a drive path; Chromium may hand navigation
  // URLs with different drive-letter / segment casing for the very same file.
  // `platform: 'win32'` exercises the Windows code path deterministically on
  // this POSIX host and on CI.
  const appEntryUrl = 'file:///C:/app/out/renderer/index.html';
  const platform = 'win32' as const;

  it('allows navigation to the exact app entry (file:///C:/…)', () => {
    const wc = fakeWebContents(appEntryUrl);
    applyNavigationHardening(wc, { appEntryUrl, platform });
    expect(wc.fireWillNavigate(appEntryUrl)).toBe(false);
  });

  it('allows the entry despite drive-letter and segment case differences', () => {
    const wc = fakeWebContents(appEntryUrl);
    applyNavigationHardening(wc, { appEntryUrl, platform });
    expect(wc.fireWillNavigate('file:///c:/app/out/renderer/index.html')).toBe(false);
    expect(wc.fireWillNavigate('file:///C:/APP/out/Renderer/index.html')).toBe(false);
  });

  it('blocks a sibling file in the app directory that is not the entry', () => {
    const wc = fakeWebContents(appEntryUrl);
    applyNavigationHardening(wc, { appEntryUrl, platform });
    expect(wc.fireWillNavigate('file:///C:/app/out/renderer/other.html')).toBe(true);
  });

  it('blocks an unrelated local file on Windows', () => {
    const wc = fakeWebContents(appEntryUrl);
    applyNavigationHardening(wc, { appEntryUrl, platform });
    expect(wc.fireWillNavigate('file:///C:/Windows/System32/evil.html')).toBe(true);
  });

  it('blocks data:, about:, javascript: and remote navigations on Windows too', () => {
    const wc = fakeWebContents(appEntryUrl);
    applyNavigationHardening(wc, { appEntryUrl, platform });
    expect(wc.fireWillNavigate('data:text/html,<script>alert(1)</script>')).toBe(true);
    expect(wc.fireWillNavigate('about:blank')).toBe(true);
    expect(wc.fireWillNavigate('javascript:alert(1)')).toBe(true);
    expect(wc.fireWillNavigate('https://evil.example/phish')).toBe(true);
  });
});
