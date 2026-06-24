import { describe, expect, it, vi } from 'vitest';
import {
  installNetworkGuard,
  isLocalOnlyRequest,
  type NetworkGuardSessionLike,
  type OnBeforeRequestListener,
} from '../../electron/main/security/network-guard';

const LOCAL_URLS = [
  'file:///app/index.html',
  'kawsay-media://item/42',
  'blob:https://kawsay/abc-123',
  'data:text/plain;base64,aGVsbG8=',
  'devtools://devtools/bundled/inspector.js',
];

const NETWORK_URLS = [
  'http://localhost:5173/',
  'http://127.0.0.1:5173/',
  'ws://localhost:5173/',
  'https://example.com/asset.js',
  'http://evil.example/beacon',
  'https://fonts.googleapis.com/css',
];

const DEV_LOOPBACK_URLS = [
  'http://localhost:5173/',
  'http://127.0.0.1:5173/',
  'ws://localhost:5173/',
  'http://[::1]:5173/main.tsx',
];

const NON_DEV_URLS = [
  'http://evil.example/beacon',
  'https://localhost/secure',
  'http://10.0.0.5/lan',
  'ftp://localhost/file',
  'http://localhost.evil.example/',
];

// X1/#16 — a `file:` URL that carries an authority targets a REMOTE host, not a
// local file. On Windows `file://host/share` is a UNC path → outbound SMB
// (TCP 445) + NTLM credential leak. Only the host-less `file:///…` form is local.
const REMOTE_AUTHORITY_FILE_URLS = [
  'file://remote.example/x',
  'file://192.168.1.50/c$/secret.txt',
  'file://attacker.example/share/x',
];

const LOCAL_FILE_URLS = ['file:///app/index.html', 'file:///Users/me/local.txt'];

describe('isLocalOnlyRequest — deny-by-default (ARCHITECTURE §6.1 / AC-4)', () => {
  describe('packaged build: local schemes only, NO network at all', () => {
    it.each(LOCAL_URLS)('allows the local scheme %s', (url) => {
      expect(isLocalOnlyRequest(url, { isPackaged: true })).toBe(true);
    });

    it.each(NETWORK_URLS)('cancels the network URL %s', (url) => {
      expect(isLocalOnlyRequest(url, { isPackaged: true })).toBe(false);
    });

    it('denies an unparseable URL (deny-by-default)', () => {
      expect(isLocalOnlyRequest('not a url', { isPackaged: true })).toBe(false);
      expect(isLocalOnlyRequest('', { isPackaged: true })).toBe(false);
    });
  });

  describe('dev build: additionally permits Vite loopback http + HMR ws', () => {
    it.each(LOCAL_URLS)('still allows the local scheme %s', (url) => {
      expect(isLocalOnlyRequest(url, { isPackaged: false })).toBe(true);
    });

    it.each(DEV_LOOPBACK_URLS)('allows dev loopback %s', (url) => {
      expect(isLocalOnlyRequest(url, { isPackaged: false })).toBe(true);
    });

    it.each(NON_DEV_URLS)('still cancels non-loopback / non-dev URL %s', (url) => {
      expect(isLocalOnlyRequest(url, { isPackaged: false })).toBe(false);
    });
  });
});

describe('isLocalOnlyRequest — a file: URL carrying a remote authority is denied (X1/#16)', () => {
  it.each(REMOTE_AUTHORITY_FILE_URLS)(
    'cancels remote-authority file URL %s in a packaged build (UNC → SMB egress)',
    (url) => {
      expect(isLocalOnlyRequest(url, { isPackaged: true })).toBe(false);
    },
  );

  it.each(REMOTE_AUTHORITY_FILE_URLS)(
    'cancels remote-authority file URL %s in a dev build too',
    (url) => {
      expect(isLocalOnlyRequest(url, { isPackaged: false })).toBe(false);
    },
  );

  it.each(LOCAL_FILE_URLS)('still allows the host-less local file URL %s', (url) => {
    expect(isLocalOnlyRequest(url, { isPackaged: true })).toBe(true);
  });
});

function createFakeSession(): {
  session: NetworkGuardSessionLike;
  onBeforeRequest: ReturnType<typeof vi.fn>;
  fire: (url: string) => Promise<{ cancel: boolean }>;
} {
  let listener: OnBeforeRequestListener | undefined;
  const onBeforeRequest = vi.fn(
    (_filter: { urls: string[] }, registered: OnBeforeRequestListener) => {
      listener = registered;
    },
  );
  const session: NetworkGuardSessionLike = { webRequest: { onBeforeRequest } };
  const fire = (url: string): Promise<{ cancel: boolean }> =>
    new Promise((resolve) => {
      if (listener === undefined) {
        throw new Error('network guard was not installed');
      }
      listener({ url }, resolve);
    });
  return { session, onBeforeRequest, fire };
}

describe('installNetworkGuard — webRequest.onBeforeRequest kill-switch', () => {
  it('registers a single catch-all <all_urls> handler', () => {
    const { session, onBeforeRequest } = createFakeSession();
    installNetworkGuard(session, { isPackaged: true });
    expect(onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(onBeforeRequest.mock.calls[0]?.[0]).toEqual({ urls: ['<all_urls>'] });
  });

  it('cancels a non-local (remote) request', async () => {
    const { session, fire } = createFakeSession();
    installNetworkGuard(session, { isPackaged: true });
    expect(await fire('https://example.com/track')).toEqual({ cancel: true });
  });

  it('allows a local request', async () => {
    const { session, fire } = createFakeSession();
    installNetworkGuard(session, { isPackaged: true });
    expect(await fire('file:///app/index.html')).toEqual({ cancel: false });
    expect(await fire('kawsay-media://item/7')).toEqual({ cancel: false });
  });

  it('cancels loopback http in the PACKAGED guard (ships with NO network)', async () => {
    const { session, fire } = createFakeSession();
    installNetworkGuard(session, { isPackaged: true });
    expect(await fire('http://localhost:5173/')).toEqual({ cancel: true });
    expect(await fire('ws://127.0.0.1:5173/')).toEqual({ cancel: true });
  });

  it('permits loopback http + HMR ws only in the DEV guard', async () => {
    const { session, fire } = createFakeSession();
    installNetworkGuard(session, { isPackaged: false });
    expect(await fire('http://localhost:5173/')).toEqual({ cancel: false });
    expect(await fire('ws://localhost:5173/')).toEqual({ cancel: false });
    expect(await fire('https://example.com/x')).toEqual({ cancel: true });
  });

  it('cancels a file:// request that carries a remote authority (UNC → SMB, X1/#16)', async () => {
    const { session, fire } = createFakeSession();
    installNetworkGuard(session, { isPackaged: true });
    expect(await fire('file://remote.example/share/x')).toEqual({ cancel: true });
    expect(await fire('file://192.168.1.50/c$/secret.txt')).toEqual({ cancel: true });
    // A host-less local file URL is genuinely local and still proceeds.
    expect(await fire('file:///Users/me/local.txt')).toEqual({ cancel: false });
  });
});
