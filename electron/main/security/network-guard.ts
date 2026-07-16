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
 * scheme AND carries no remote authority — a `file://host/share` URL is a remote
 * target (on Windows a UNC path → outbound SMB), so only the host-less
 * `file:///…` form is local — or, in development, the Vite dev server / HMR
 * websocket on a loopback host — or it is one of the narrowly-scoped, opt-in
 * model downloads (whisper transcription + M4 embedder; see
 * {@link isAllowedModelDownloadRequest} / AC-17, ADR-0027 Decision 6, ADR-0029).
 * Anything unrecognised — including unparseable URLs and every other remote
 * origin — is cancelled.
 */

import {
  MODEL_DOWNLOAD_REDIRECT_HOST,
  MODEL_DOWNLOAD_URL,
} from '../transcription/model-source';
import {
  EMBED_MODEL_DOWNLOAD_REDIRECT_HOST,
  EMBED_MODEL_DOWNLOAD_URL,
} from '../search/embed-model-source';
import { log } from '../log';

/** Schemes that never leave the machine and are always permitted. */
const LOCAL_SCHEMES: ReadonlySet<string> = new Set([
  'file:',
  'kawsay-media:',
  'blob:',
  'data:',
  'devtools:',
]);

/**
 * Local schemes whose authority denotes a REAL remote host — for these a
 * non-empty hostname is network egress, not a local resource. `file://host/share`
 * is a Windows UNC path → outbound SMB (TCP 445) + NTLM credential leak, so only
 * the host-less `file:///…` form is truly local. (`kawsay-media:`/`devtools:`
 * also carry an authority, but it is an in-process handler/internal host that is
 * never dialled over the network, so they are intentionally NOT listed here.)
 */
const HOST_SENSITIVE_LOCAL_SCHEMES: ReadonlySet<string> = new Set(['file:']);

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
   * `app.isPackaged`. A packaged build grants no LOCAL network relaxation — not even
   * loopback; the dev-server / HMR exception applies only when this is `false`. The
   * only outbound requests a packaged build still permits are the opt-in, scoped model
   * downloads (see {@link isAllowedModelDownloadRequest}), which are gated on their own
   * and evaluated independently of this flag.
   */
  readonly isPackaged: boolean;
}

/**
 * Decide whether a request URL is local-only and may proceed (ARCHITECTURE §6.1).
 *
 * Deny-by-default: returns `true` only for an explicit local scheme that carries
 * no remote authority (a `file://host/…` UNC target is rejected), or — in a
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
    // A host-sensitive local scheme (`file:`) that carries an authority targets a
    // REMOTE host (Windows UNC → SMB), not a local resource: deny it. Only the
    // host-less `file:///…` form is truly local. Other local schemes
    // (`kawsay-media:`/`devtools:`) may also have a non-empty hostname, but it is
    // an in-process/internal host that never reaches the network, so they pass.
    if (HOST_SENSITIVE_LOCAL_SCHEMES.has(parsed.protocol) && parsed.hostname !== '') {
      return false;
    }
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
  /**
   * HTTP method (Electron always provides it on real requests). The model-download
   * allowlist permits ONLY `GET`; an absent method is treated as not-GET and denied.
   */
  readonly method?: string;
  /**
   * Upload body chunks (structural subset of Electron's `UploadData[]`). Absent or
   * empty ⇒ no body. The model download must be a pure GET with NO body, so a
   * non-empty `uploadData` is never allowed — it would be an exfiltration channel.
   */
  readonly uploadData?: readonly unknown[];
}

/** One auditable egress allowlist entry — an opt-in, integrity-verified model
 *  download pinned two ways: the EXACT origin release URL and its signed CDN
 *  redirect host. */
export interface ModelDownloadAllowlistEntry {
  readonly originUrl: string;
  readonly redirectHost: string;
}

/**
 * The auditable egress allowlist (AC-17 / ADR-0027 Decision 6, ADR-0029).
 *
 * The ONLY outbound requests a packaged Kawsay build may make are the opt-in,
 * integrity-verified model downloads — the whisper transcription model and the
 * M4 smart-search embedder. Each entry is pinned two ways:
 *  - `originUrl` — the EXACT release URL we GET first (string-equal match, the
 *    narrowest possible);
 *  - `redirectHost` — the host GitHub's 302 redirects to. That signed CDN URL
 *    carries a time-limited, per-request `se=/sig=/jwt=` path+query, so this leg
 *    is matched by host (+ https + GET + empty body), not by exact URL.
 * Each entry is sourced from the same `*-model-source` module that pins the
 * downloader and integrity check, so the allowlist cannot drift from what is
 * actually fetched, and a reviewer can audit every permitted origin at a glance.
 * A request is permitted iff it exactly equals some entry's `originUrl`, or is an
 * https request whose host equals some entry's `redirectHost`; anything else stays
 * denied. Adding a model = adding exactly one narrowly-scoped entry here.
 */
export const MODEL_DOWNLOAD_ALLOWLIST: readonly ModelDownloadAllowlistEntry[] = [
  // Whisper transcription model (M2 / ADR-0027 Decision 6).
  { originUrl: MODEL_DOWNLOAD_URL, redirectHost: MODEL_DOWNLOAD_REDIRECT_HOST },
  // M4 smart-search embedder model (ADR-0029) — the same GET-only, empty-body,
  // exact-origin-or-https-CDN-host shape as whisper; the ONLY net-new egress.
  { originUrl: EMBED_MODEL_DOWNLOAD_URL, redirectHost: EMBED_MODEL_DOWNLOAD_REDIRECT_HOST },
];

/** True iff the request carries no upload body (the model download is a pure GET). */
function hasEmptyUploadBody(uploadData: readonly unknown[] | undefined): boolean {
  return uploadData === undefined || uploadData.length === 0;
}

/**
 * Decide whether a request is one of the permitted opt-in model downloads (AC-17,
 * ADR-0029).
 *
 * Deny-by-default and deliberately narrow: the request must be a `GET` with an
 * EMPTY upload body, targeting EITHER an allowlist entry's exact pinned origin
 * release URL OR its signed-CDN redirect host over https. Every other shape — a
 * POST, a body-bearing GET, a different path/host, a plaintext CDN leg, an
 * unparseable URL — returns `false`. This predicate is the entire widening of the
 * zero-egress guard, so it is intentionally explicit and easy to audit.
 */
export function isAllowedModelDownloadRequest(details: BeforeRequestDetails): boolean {
  // Only ever a GET, and only ever with no upload body — never a write, never a
  // request that could smuggle user memories out in its payload.
  if (details.method === undefined || details.method.toUpperCase() !== 'GET') {
    return false;
  }
  if (!hasEmptyUploadBody(details.uploadData)) {
    return false;
  }

  // Origin leg: the EXACT pinned release URL of ANY allowlist entry. A string-equal
  // match is the narrowest possible and already encodes the https scheme + host + path.
  if (MODEL_DOWNLOAD_ALLOWLIST.some((entry) => details.url === entry.originUrl)) {
    return true;
  }

  // CDN leg: GitHub's 302 lands on a fixed host with a varying signed path/query, so
  // match the host EXACTLY over https against ANY allowlist entry's redirect host. An
  // unparseable URL, a non-https leg, or a sub-/super-domain spoof
  // (e.g. `…githubusercontent.com.evil.example`) all fail.
  let parsed: URL;
  try {
    parsed = new URL(details.url);
  } catch {
    return false;
  }
  return MODEL_DOWNLOAD_ALLOWLIST.some(
    (entry) => parsed.protocol === 'https:' && parsed.hostname === entry.redirectHost,
  );
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
 * `<all_urls>` handler that cancels every request except a strictly-local one
 * (see {@link isLocalOnlyRequest}) or one of the permitted opt-in model downloads
 * (see {@link isAllowedModelDownloadRequest}). Must be installed BEFORE any
 * window loads content (ARCHITECTURE §10), on `defaultSession` and any
 * additional sessions the app creates.
 */
export function installNetworkGuard(
  session: NetworkGuardSessionLike,
  options: NetworkGuardOptions,
): void {
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const allowed =
      isLocalOnlyRequest(details.url, options) || isAllowedModelDownloadRequest(details);
    if (!allowed && !options.isPackaged) {
      // Dev breadcrumb: surface anything the guard cancels while iterating, so a
      // mistakenly-remote asset is noticed immediately. Silent in packaged builds.
      log.error(`[kawsay] network guard cancelled non-local request: ${details.url}`); // nosemgrep: unsafe-formatstring
    }
    callback({ cancel: !allowed });
  });
}
