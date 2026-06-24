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

describe('applyNavigationHardening (navigation + window.open lockdown, ARCHITECTURE §2.1)', () => {
  const appEntryUrl = 'file:///app/out/renderer/index.html';

  function fakeWebContents() {
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
        return appEntryUrl;
      },
      fireWillNavigate(url: string) {
        let prevented = false;
        willNavigate?.({ preventDefault: () => (prevented = true) }, url);
        return prevented;
      },
    };
    return wc;
  }

  it('denies every window.open / target=_blank attempt', () => {
    const wc = fakeWebContents();
    applyNavigationHardening(wc, { appEntryUrl });
    expect(wc.openHandler?.({ url: 'https://example.com' })).toEqual({ action: 'deny' });
  });

  it('allows navigation to the exact app entry', () => {
    const wc = fakeWebContents();
    applyNavigationHardening(wc, { appEntryUrl });
    expect(wc.fireWillNavigate(appEntryUrl)).toBe(false);
  });

  it('blocks navigation to an unrelated local file (opaque file:// origin)', () => {
    const wc = fakeWebContents();
    applyNavigationHardening(wc, { appEntryUrl });
    expect(wc.fireWillNavigate('file:///etc/passwd')).toBe(true);
  });

  it('blocks a sibling file in the app directory that is not the entry', () => {
    const wc = fakeWebContents();
    applyNavigationHardening(wc, { appEntryUrl });
    expect(wc.fireWillNavigate('file:///app/out/renderer/other.html')).toBe(true);
  });

  it('blocks data:, about: and javascript: navigations (opaque origins)', () => {
    const wc = fakeWebContents();
    applyNavigationHardening(wc, { appEntryUrl });
    expect(wc.fireWillNavigate('data:text/html,<script>alert(1)</script>')).toBe(true);
    expect(wc.fireWillNavigate('about:blank')).toBe(true);
    expect(wc.fireWillNavigate('javascript:alert(1)')).toBe(true);
  });

  it('blocks remote origins', () => {
    const wc = fakeWebContents();
    applyNavigationHardening(wc, { appEntryUrl });
    expect(wc.fireWillNavigate('https://evil.example/phish')).toBe(true);
  });

  it('allows the dev-server origin ONLY when a dev server is configured', () => {
    const devServerUrl = 'http://localhost:5173';
    const wc = fakeWebContents();
    applyNavigationHardening(wc, { appEntryUrl, devServerUrl });
    expect(wc.fireWillNavigate('http://localhost:5173/any/route')).toBe(false);
    // A foreign origin is still blocked, even in development.
    expect(wc.fireWillNavigate('http://localhost:4444/')).toBe(true);
  });
});
