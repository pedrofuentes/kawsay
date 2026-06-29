import { describe, expect, it, vi } from 'vitest';
import {
  buildContentSecurityPolicy,
  installContentSecurityPolicy,
} from '../../electron/main/security/csp';

function parsePolicy(csp: string): Map<string, string[]> {
  return new Map(
    csp.split('; ').map((directive) => {
      const [name, ...values] = directive.split(' ');
      return [name, values];
    }),
  );
}

function expectDirective(csp: string, name: string, values: readonly string[]): void {
  expect(parsePolicy(csp).get(name)).toEqual(values);
}

describe('buildContentSecurityPolicy (zero-egress CSP, ARCHITECTURE §2.2 / AC-4)', () => {
  it('locks the production policy down to local-only, no-network defaults', () => {
    const csp = buildContentSecurityPolicy();
    expectDirective(csp, 'default-src', ["'none'"]);
    // The renderer-side egress kill-switch: no fetch/XHR/WebSocket/EventSource.
    expectDirective(csp, 'connect-src', ["'none'"]);
    expectDirective(csp, 'script-src', ["'self'"]);
    expectDirective(csp, 'style-src', ["'self'"]);
    expectDirective(csp, 'font-src', ["'self'"]);
    expectDirective(csp, 'img-src', ["'self'", 'data:']);
    expectDirective(csp, 'object-src', ["'none'"]);
    expectDirective(csp, 'base-uri', ["'none'"]);
    expectDirective(csp, 'form-action', ["'none'"]);
  });

  it('never weakens production script execution with unsafe-inline or unsafe-eval', () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('relaxes ONLY for the dev server (HMR needs the dev origin + websocket)', () => {
    const csp = buildContentSecurityPolicy({ devServerUrl: 'http://localhost:5173' });
    expectDirective(csp, 'script-src', [
      "'self'",
      "'unsafe-inline'",
      "'unsafe-eval'",
      'http://localhost:5173',
    ]);
    expectDirective(csp, 'style-src', ["'self'", "'unsafe-inline'", 'http://localhost:5173']);
    expectDirective(csp, 'connect-src', ["'self'", 'http://localhost:5173', 'ws://localhost:5173']);
    // Even relaxed, the dev policy keeps a default-src floor.
    expectDirective(csp, 'default-src', ["'none'"]);
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
