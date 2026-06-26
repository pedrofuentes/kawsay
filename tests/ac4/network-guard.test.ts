import { describe, expect, it, vi } from 'vitest';
import {
  installNetworkGuard,
  isAllowedModelDownloadRequest,
  isLocalOnlyRequest,
  type NetworkGuardSessionLike,
  type OnBeforeRequestListener,
} from '../../electron/main/security/network-guard';
import {
  MODEL_DOWNLOAD_REDIRECT_HOST,
  MODEL_DOWNLOAD_URL,
} from '../../electron/main/transcription/model-source';

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
  fire: (
    url: string,
    options?: { method?: string; uploadData?: readonly unknown[] },
  ) => Promise<{ cancel: boolean }>;
} {
  let listener: OnBeforeRequestListener | undefined;
  const onBeforeRequest = vi.fn(
    (_filter: { urls: string[] }, registered: OnBeforeRequestListener) => {
      listener = registered;
    },
  );
  const session: NetworkGuardSessionLike = { webRequest: { onBeforeRequest } };
  const fire = (
    url: string,
    options: { method?: string; uploadData?: readonly unknown[] } = {},
  ): Promise<{ cancel: boolean }> =>
    new Promise((resolve) => {
      if (listener === undefined) {
        throw new Error('network guard was not installed');
      }
      listener({ url, method: options.method ?? 'GET', uploadData: options.uploadData }, resolve);
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

// ─────────────────────────────────────────────────────────────────────────────
// AC-17 / ADR-0027 Decision 6 — the scoped model-download egress allowlist.
//
// This is the load-bearing privacy test: the ONLY egress the guard permits is
// the opt-in transcription model download — a GET, with an empty upload body, to
// either the pinned origin release URL or its signed CDN redirect host. EVERY
// other request — a POST to that same host, a GET to a different path/host, a
// non-https CDN leg, a body-carrying GET — stays denied. If this allowlist ever
// widens, "your memories never leave this computer" is broken.
// ─────────────────────────────────────────────────────────────────────────────

// A representative signed CDN URL: GitHub's 302 from the pinned origin lands on
// `release-assets.githubusercontent.com` with time-limited `se=/sig=/jwt=` query
// params and an opaque path. The path/query VARY per request, so the guard keys
// on the host (+ scheme + GET + empty body), not the exact URL, for this leg.
const SIGNED_CDN_URL =
  'https://release-assets.githubusercontent.com/github-production-release-asset-2e65be/' +
  '900001/ggml-small.bin?se=2025-01-01T00%3A00%3A00Z&sig=abcDEF123&jwt=eyJhbGciOiJ' +
  'IUzI1NiJ9.payload.signature';

describe('isAllowedModelDownloadRequest — scoped model-download allowlist (AC-17 / ADR-0027)', () => {
  it('ALLOWS a GET to the pinned origin release URL with an empty body', () => {
    expect(isAllowedModelDownloadRequest({ url: MODEL_DOWNLOAD_URL, method: 'GET' })).toBe(true);
    expect(
      isAllowedModelDownloadRequest({ url: MODEL_DOWNLOAD_URL, method: 'GET', uploadData: [] }),
    ).toBe(true);
  });

  it('ALLOWS a GET to the signed CDN redirect host (path/query vary, host is matched)', () => {
    expect(isAllowedModelDownloadRequest({ url: SIGNED_CDN_URL, method: 'GET' })).toBe(true);
    // A different signed path on the same host is still allowed (host-keyed leg).
    expect(
      isAllowedModelDownloadRequest({
        url: `https://${MODEL_DOWNLOAD_REDIRECT_HOST}/other/path.bin?se=x&sig=y`,
        method: 'GET',
      }),
    ).toBe(true);
  });

  it('DENIES a POST to the pinned origin URL (only GET is permitted)', () => {
    expect(isAllowedModelDownloadRequest({ url: MODEL_DOWNLOAD_URL, method: 'POST' })).toBe(false);
  });

  it('DENIES a POST to the signed CDN host', () => {
    expect(isAllowedModelDownloadRequest({ url: SIGNED_CDN_URL, method: 'POST' })).toBe(false);
  });

  it('DENIES a GET that carries a non-empty upload body (exfiltration vector)', () => {
    expect(
      isAllowedModelDownloadRequest({
        url: MODEL_DOWNLOAD_URL,
        method: 'GET',
        uploadData: [{ bytes: Buffer.from('memories') }],
      }),
    ).toBe(false);
    expect(
      isAllowedModelDownloadRequest({
        url: SIGNED_CDN_URL,
        method: 'GET',
        uploadData: [{ bytes: Buffer.from('memories') }],
      }),
    ).toBe(false);
  });

  it('DENIES a GET to a DIFFERENT path on the pinned origin host', () => {
    expect(
      isAllowedModelDownloadRequest({
        url: 'https://github.com/pedrofuentes/kawsay/releases/download/models-v1/evil.bin',
        method: 'GET',
      }),
    ).toBe(false);
    expect(
      isAllowedModelDownloadRequest({
        url: 'https://github.com/pedrofuentes/kawsay/releases/download/models-v1/ggml-small.bin?x=1',
        method: 'GET',
      }),
    ).toBe(false);
  });

  it('DENIES a GET to a different host entirely', () => {
    expect(
      isAllowedModelDownloadRequest({ url: 'https://example.com/ggml-small.bin', method: 'GET' }),
    ).toBe(false);
    expect(
      isAllowedModelDownloadRequest({
        url: 'https://raw.githubusercontent.com/pedrofuentes/kawsay/main/secret',
        method: 'GET',
      }),
    ).toBe(false);
  });

  it('DENIES a subdomain-spoof of the CDN host (exact host match, not suffix)', () => {
    expect(
      isAllowedModelDownloadRequest({
        url: `https://${MODEL_DOWNLOAD_REDIRECT_HOST}.evil.example/ggml-small.bin`,
        method: 'GET',
      }),
    ).toBe(false);
    expect(
      isAllowedModelDownloadRequest({
        url: 'https://evil.example/release-assets.githubusercontent.com/x',
        method: 'GET',
      }),
    ).toBe(false);
  });

  it('DENIES a non-https (plaintext) CDN leg', () => {
    expect(
      isAllowedModelDownloadRequest({
        url: `http://${MODEL_DOWNLOAD_REDIRECT_HOST}/x?se=1&sig=2`,
        method: 'GET',
      }),
    ).toBe(false);
  });

  it('DENIES an unparseable URL and a missing method (deny-by-default)', () => {
    expect(isAllowedModelDownloadRequest({ url: 'not a url', method: 'GET' })).toBe(false);
    expect(isAllowedModelDownloadRequest({ url: MODEL_DOWNLOAD_URL })).toBe(false);
  });
});

describe('installNetworkGuard — the model download is the ONLY permitted egress', () => {
  it('lets the pinned GET (origin + signed CDN host, empty body) through the guard', async () => {
    const { session, fire } = createFakeSession();
    installNetworkGuard(session, { isPackaged: true });
    // The origin leg and the followed-redirect CDN leg both proceed…
    expect(await fire(MODEL_DOWNLOAD_URL, { method: 'GET' })).toEqual({ cancel: false });
    expect(await fire(SIGNED_CDN_URL, { method: 'GET' })).toEqual({ cancel: false });
  });

  it('still cancels everything that is not the exact model GET', async () => {
    const { session, fire } = createFakeSession();
    installNetworkGuard(session, { isPackaged: true });
    // POST to the same pinned host…
    expect(await fire(MODEL_DOWNLOAD_URL, { method: 'POST' })).toEqual({ cancel: true });
    // …a body-carrying GET (would smuggle memories out)…
    expect(
      await fire(MODEL_DOWNLOAD_URL, { method: 'GET', uploadData: [{ bytes: Buffer.from('x') }] }),
    ).toEqual({ cancel: true });
    // …a GET to a different path on the same host…
    expect(
      await fire('https://github.com/pedrofuentes/kawsay/releases/download/models-v1/evil.bin', {
        method: 'GET',
      }),
    ).toEqual({ cancel: true });
    // …a GET to an unrelated host…
    expect(await fire('https://example.com/track', { method: 'GET' })).toEqual({ cancel: true });
    // …and a plaintext CDN leg.
    expect(await fire(`http://${MODEL_DOWNLOAD_REDIRECT_HOST}/x`, { method: 'GET' })).toEqual({
      cancel: true,
    });
  });
});
