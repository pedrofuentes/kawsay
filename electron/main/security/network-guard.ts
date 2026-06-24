/**
 * Runtime zero-egress network guard (ARCHITECTURE §6.1 / AC-4).
 *
 * The authoritative, request-level kill-switch: a `webRequest.onBeforeRequest`
 * handler installed on every session BEFORE any window loads, which cancels
 * every request whose scheme is not strictly local. It is the runtime half of
 * the zero-egress guarantee — the companion to the renderer-side CSP
 * (`connect-src 'none'`, see `csp.ts`). Together they ensure a packaged Kawsay
 * build makes no outbound network connection of any kind.
 *
 * Deny-by-default: a URL is permitted ONLY when it matches an explicit local
 * scheme (or, in development, the Vite dev server / HMR websocket on loopback).
 * Anything unrecognised — including unparseable URLs and every remote origin —
 * is cancelled.
 */

/** Schemes that never leave the machine and are always permitted. */
const LOCAL_SCHEMES: ReadonlySet<string> = new Set([
  'file:',
  'kawsay-media:',
  'blob:',
  'data:',
  'devtools:',
]);

/** Loopback hostnames the Vite dev server / HMR socket bind to — DEV ONLY. */
const DEV_LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Schemes the Vite dev server speaks — DEV ONLY. Only plaintext `http:` (asset
 * serving) and `ws:` (HMR) are relaxed; `https:`/`wss:` stay denied so that a
 * remote `https://localhost`-style origin can never slip through in dev.
 */
const DEV_LOOPBACK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'ws:']);

export interface NetworkGuardOptions {
  /**
   * `app.isPackaged`. A packaged build permits NO network whatsoever — not even
   * loopback. The dev-server relaxation applies only when this is `false`.
   */
  readonly isPackaged: boolean;
}

/**
 * Decide whether a request URL is local-only and may proceed (ARCHITECTURE §6.1).
 *
 * Deny-by-default: returns `true` only for an explicit local scheme, or — in a
 * development build — for the Vite dev server / HMR socket on a loopback host.
 * Every other URL, and anything that fails to parse, returns `false`.
 */
export function isLocalOnlyRequest(rawUrl: string, options: NetworkGuardOptions): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Deny-by-default: a URL we cannot even parse is never treated as local.
    return false;
  }

  if (LOCAL_SCHEMES.has(parsed.protocol)) {
    return true;
  }

  // Packaged builds ship with zero network — no loopback, no exceptions.
  if (options.isPackaged) {
    return false;
  }

  // DEV ONLY: permit the Vite dev server (http) and its HMR websocket (ws) on a
  // loopback host. Hostname is matched exactly so `localhost.evil.example` and
  // friends do not qualify.
  return DEV_LOOPBACK_SCHEMES.has(parsed.protocol) && DEV_LOOPBACK_HOSTS.has(parsed.hostname);
}

/** A single request observed by the guard. Structural subset of Electron's
 *  `OnBeforeRequestListenerDetails`, so this module unit-tests without Electron. */
export interface BeforeRequestDetails {
  readonly url: string;
}

/** The guard's verdict for a request: cancel it, or let it proceed. */
export interface BeforeRequestResponse {
  readonly cancel: boolean;
}

export type OnBeforeRequestListener = (
  details: BeforeRequestDetails,
  callback: (response: BeforeRequestResponse) => void,
) => void;

/** Structural view of the `session` bits the guard uses (see `csp.ts`). */
export interface NetworkGuardSessionLike {
  readonly webRequest: {
    onBeforeRequest(filter: { urls: string[] }, listener: OnBeforeRequestListener): void;
  };
}

/**
 * Install the zero-egress guard on a session. Registers a single catch-all
 * `<all_urls>` handler that cancels every non-local request. Must be installed
 * BEFORE any window loads content (ARCHITECTURE §10), on `defaultSession` and
 * any additional sessions the app creates.
 */
export function installNetworkGuard(
  session: NetworkGuardSessionLike,
  options: NetworkGuardOptions,
): void {
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const allowed = isLocalOnlyRequest(details.url, options);
    if (!allowed && !options.isPackaged) {
      // Dev breadcrumb: surface anything the guard cancels while iterating, so a
      // mistakenly-remote asset is noticed immediately. Silent in packaged builds.
      console.error(`[kawsay] network guard cancelled non-local request: ${details.url}`);
    }
    callback({ cancel: !allowed });
  });
}
