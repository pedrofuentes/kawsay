import { describe, expect, it } from 'vitest';
import { isTrustedSenderUrl } from '../../electron/main/ipc/sender';

const rendererEntryPath = '/Applications/Kawsay.app/Contents/Resources/app/out/renderer/index.html';
const rendererEntryUrl = 'file://' + rendererEntryPath;

describe('isTrustedSenderUrl (IPC sender-origin guard, ARCHITECTURE §2.3)', () => {
  // The macOS-style fixtures are case-sensitive POSIX paths; pin the platform so
  // the file:// path comparison is exercised under POSIX semantics on any host
  // (including the Windows CI runner).
  const posix = { rendererEntryPath, platform: 'darwin' as const };

  it('trusts ONLY the exact packaged renderer entry served from file://', () => {
    expect(isTrustedSenderUrl(rendererEntryUrl, posix)).toBe(true);
  });

  it('rejects an attacker-dropped local file:// document (not the app entry)', () => {
    // An attacker who drops HTML on disk and lures the app into loading it must
    // NOT be trusted merely because the scheme is file://.
    expect(isTrustedSenderUrl('file:///tmp/evil/attacker.html', posix)).toBe(false);
  });

  it('rejects a sibling file in the app directory that is not the entry', () => {
    const sibling = 'file:///Applications/Kawsay.app/Contents/Resources/app/out/renderer/evil.html';
    expect(isTrustedSenderUrl(sibling, posix)).toBe(false);
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

describe('isTrustedSenderUrl — Windows packaged renderer (case-insensitive FS, issue #34)', () => {
  // On Windows the packaged entry is a drive path. The `file://` URL Chromium
  // hands the main process (`file:///C:/…`) and the path the main process
  // derives from `app.getAppPath()` (`C:\…`) can differ in drive-letter and
  // segment casing, and NTFS is case-insensitive. `platform: 'win32'` exercises
  // the Windows code path deterministically on this POSIX host and on CI.
  const winEntryPath = 'C:\\app\\out\\renderer\\index.html';
  const winEntryUrl = 'file:///C:/app/out/renderer/index.html';
  const win = { rendererEntryPath: winEntryPath, platform: 'win32' as const };

  it('trusts the exact packaged renderer entry (file:///C:/… ⇄ C:\\…)', () => {
    expect(isTrustedSenderUrl(winEntryUrl, win)).toBe(true);
  });

  it('trusts the entry despite drive-letter and segment case differences', () => {
    expect(isTrustedSenderUrl('file:///c:/app/out/renderer/index.html', win)).toBe(true);
    expect(isTrustedSenderUrl('file:///C:/APP/OUT/Renderer/index.html', win)).toBe(true);
  });

  it('rejects an attacker-dropped local file:// document on another path', () => {
    expect(isTrustedSenderUrl('file:///C:/evil/attacker.html', win)).toBe(false);
  });

  it('rejects a sibling file in the app directory that is not the entry', () => {
    expect(isTrustedSenderUrl('file:///C:/app/out/renderer/other.html', win)).toBe(false);
  });

  it('rejects opaque-origin and remote senders on Windows too', () => {
    expect(isTrustedSenderUrl('data:text/html,<script>alert(1)</script>', win)).toBe(false);
    expect(isTrustedSenderUrl('about:blank', win)).toBe(false);
    expect(isTrustedSenderUrl('javascript:alert(1)', win)).toBe(false);
    expect(isTrustedSenderUrl('https://evil.example/phish', win)).toBe(false);
  });

  it('rejects EVERY file:// sender when no renderer entry is configured', () => {
    expect(isTrustedSenderUrl(winEntryUrl, { platform: 'win32' })).toBe(false);
  });
});
