import { describe, expect, it, vi } from 'vitest';
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

  it('denies every window.open / target=_blank attempt', () => {
    const wc = fakeWebContents('file:///app/index.html');
    applyNavigationHardening(wc);
    expect(wc.openHandler?.({ url: 'https://example.com' })).toEqual({ action: 'deny' });
  });

  it('blocks navigation to a different origin', () => {
    const wc = fakeWebContents('file:///app/index.html');
    applyNavigationHardening(wc);
    expect(wc.fireWillNavigate('https://evil.example/phish')).toBe(true);
  });

  it('permits navigation within the same origin', () => {
    const wc = fakeWebContents('file:///app/index.html');
    applyNavigationHardening(wc);
    expect(wc.fireWillNavigate('file:///app/other.html')).toBe(false);
  });
});
