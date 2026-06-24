import { describe, expect, it } from 'vitest';
import { isTrustedSenderUrl } from '../../electron/main/ipc/sender';

describe('isTrustedSenderUrl (IPC sender-origin guard, ARCHITECTURE §2.3)', () => {
  it('trusts the packaged renderer served from file://', () => {
    expect(isTrustedSenderUrl('file:///Applications/Kawsay.app/out/renderer/index.html')).toBe(true);
  });

  it('rejects any remote origin', () => {
    expect(isTrustedSenderUrl('https://evil.example/phish')).toBe(false);
    expect(isTrustedSenderUrl('http://example.com')).toBe(false);
  });

  it('rejects a malformed or empty URL instead of throwing', () => {
    expect(isTrustedSenderUrl('')).toBe(false);
    expect(isTrustedSenderUrl('not a url')).toBe(false);
  });

  it('trusts the dev-server origin ONLY when a dev server is configured', () => {
    const devServerUrl = 'http://localhost:5173';
    expect(isTrustedSenderUrl('http://localhost:5173/index.html', { devServerUrl })).toBe(true);
    // Same origin must NOT be trusted in production (no dev server configured).
    expect(isTrustedSenderUrl('http://localhost:5173/index.html')).toBe(false);
    // A different dev origin is still rejected.
    expect(isTrustedSenderUrl('http://localhost:4444', { devServerUrl })).toBe(false);
  });
});
