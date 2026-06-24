import { describe, expect, it } from 'vitest';
import { isTrustedSenderUrl } from '../../electron/main/ipc/sender';

const rendererEntryPath = '/Applications/Kawsay.app/Contents/Resources/app/out/renderer/index.html';
const rendererEntryUrl = 'file://' + rendererEntryPath;

describe('isTrustedSenderUrl (IPC sender-origin guard, ARCHITECTURE §2.3)', () => {
  it('trusts ONLY the exact packaged renderer entry served from file://', () => {
    expect(isTrustedSenderUrl(rendererEntryUrl, { rendererEntryPath })).toBe(true);
  });

  it('rejects an attacker-dropped local file:// document (not the app entry)', () => {
    // An attacker who drops HTML on disk and lures the app into loading it must
    // NOT be trusted merely because the scheme is file://.
    expect(isTrustedSenderUrl('file:///tmp/evil/attacker.html', { rendererEntryPath })).toBe(false);
  });

  it('rejects a sibling file in the app directory that is not the entry', () => {
    const sibling = 'file:///Applications/Kawsay.app/Contents/Resources/app/out/renderer/evil.html';
    expect(isTrustedSenderUrl(sibling, { rendererEntryPath })).toBe(false);
  });

  it('rejects EVERY file:// sender when no renderer entry is configured (production safety)', () => {
    expect(isTrustedSenderUrl(rendererEntryUrl)).toBe(false);
    expect(isTrustedSenderUrl('file:///tmp/evil/attacker.html')).toBe(false);
  });

  it('rejects any remote origin', () => {
    expect(isTrustedSenderUrl('https://evil.example/phish', { rendererEntryPath })).toBe(false);
    expect(isTrustedSenderUrl('http://example.com', { rendererEntryPath })).toBe(false);
  });

  it('rejects a malformed or empty URL instead of throwing', () => {
    expect(isTrustedSenderUrl('', { rendererEntryPath })).toBe(false);
    expect(isTrustedSenderUrl('not a url', { rendererEntryPath })).toBe(false);
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
