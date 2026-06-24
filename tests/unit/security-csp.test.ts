import { describe, expect, it, vi } from 'vitest';
import {
  buildContentSecurityPolicy,
  installContentSecurityPolicy,
} from '../../electron/main/security/csp';

describe('buildContentSecurityPolicy (zero-egress CSP, ARCHITECTURE §2.2 / AC-4)', () => {
  it('locks the production policy down to local-only, no-network defaults', () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).toContain("default-src 'none'");
    // The renderer-side egress kill-switch: no fetch/XHR/WebSocket/EventSource.
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it('never weakens production script execution with unsafe-inline or unsafe-eval', () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('relaxes ONLY for the dev server (HMR needs the dev origin + websocket)', () => {
    const csp = buildContentSecurityPolicy({ devServerUrl: 'http://localhost:5173' });
    expect(csp).toContain('http://localhost:5173');
    expect(csp).toContain('ws://localhost:5173');
    // Even relaxed, the dev policy keeps a default-src floor.
    expect(csp).toContain("default-src 'none'");
  });
});

describe('installContentSecurityPolicy (header injection wiring)', () => {
  it('attaches the policy to every response via onHeadersReceived', () => {
    let registered:
      | ((
          details: { responseHeaders?: Record<string, string[]> },
          cb: (r: { responseHeaders?: Record<string, string[]> }) => void,
        ) => void)
      | undefined;
    const session = {
      webRequest: {
        onHeadersReceived: vi.fn((listener) => {
          registered = listener;
        }),
      },
    };

    installContentSecurityPolicy(session);
    expect(session.webRequest.onHeadersReceived).toHaveBeenCalledTimes(1);
    expect(registered).toBeDefined();

    const callback = vi.fn();
    registered?.({ responseHeaders: { 'X-Existing': ['keep'] } }, callback);

    expect(callback).toHaveBeenCalledTimes(1);
    const sent = callback.mock.calls[0]?.[0] as { responseHeaders: Record<string, string[]> };
    expect(sent.responseHeaders['Content-Security-Policy']).toEqual([buildContentSecurityPolicy()]);
    // Existing headers are preserved.
    expect(sent.responseHeaders['X-Existing']).toEqual(['keep']);
  });
});
