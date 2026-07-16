import { MEDIA_PROTOCOL_SCHEME } from '@shared/media';

export interface CspOptions {
  /** Present only in development: relax the policy just enough for Vite HMR over
   *  this origin. Absent in production, which gets the locked-down policy. */
  readonly devServerUrl?: string | undefined;
}

/** The custom LOCAL media scheme source token (`kawsay-media:`). This is the ONLY
 *  net-new source #428 adds — to `media-src` (for <audio>/<video> playback) and
 *  `img-src` (for full-size <img>). It is NOT networked: the runtime guard treats
 *  it as strictly local and it opens no socket, so `default-src`/`connect-src` stay
 *  `'none'` and the zero-egress guarantee (AC-4) is untouched. */
const MEDIA_SCHEME_SOURCE = `${MEDIA_PROTOCOL_SCHEME}:`;

/**
 * The production Content-Security-Policy (ARCHITECTURE §2.2): local-only, no
 * remote anything. `connect-src 'none'` is the renderer-side egress kill-switch
 * (no fetch / XHR / WebSocket / EventSource) — the CSP half of the zero-egress
 * guarantee (AC-4). Media/worker/`kawsay-media:` directives are added by the
 * cards that introduce those capabilities; the shell stays maximally strict.
 */
const PRODUCTION_CSP: readonly string[] = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  `img-src 'self' data: ${MEDIA_SCHEME_SOURCE}`,
  "font-src 'self'",
  "connect-src 'none'",
  // Explicit-intent playback (#428): <audio>/<video> may load ONLY the local media
  // scheme — nothing networked. The egress floor below is unchanged.
  `media-src ${MEDIA_SCHEME_SOURCE}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
];

/**
 * Build the CSP string. Production returns the locked-down policy above. When a
 * dev server is supplied, the policy is relaxed ONLY enough for Vite HMR: its
 * origin, the HMR websocket, and the inline styles / refresh runtime the dev
 * server injects. Production never contains `unsafe-inline` or `unsafe-eval`.
 */
export function buildContentSecurityPolicy(options: CspOptions = {}): string {
  if (options.devServerUrl !== undefined) {
    return buildDevContentSecurityPolicy(options.devServerUrl);
  }
  return PRODUCTION_CSP.join('; ');
}

function buildDevContentSecurityPolicy(devServerUrl: string): string {
  const { origin } = new URL(devServerUrl);
  const websocket = origin.replace(/^http/u, 'ws');
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${origin}`,
    `style-src 'self' 'unsafe-inline' ${origin}`,
    `img-src 'self' data: ${MEDIA_SCHEME_SOURCE}`,
    `font-src 'self' ${origin}`,
    `connect-src 'self' ${origin} ${websocket}`,
    // Local media playback works in dev too — via the SAME local-only scheme.
    `media-src ${MEDIA_SCHEME_SOURCE}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
  ].join('; ');
}

/** Structural view of the `session` bits we use, so this module unit-tests
 *  without an Electron runtime. */
export interface CspHeaders {
  responseHeaders?: Record<string, string[] | string> | undefined;
}
export type OnHeadersReceivedListener = (
  details: CspHeaders,
  callback: (response: CspHeaders) => void,
) => void;
export interface CspSessionLike {
  readonly webRequest: {
    onHeadersReceived(listener: OnHeadersReceivedListener): void;
  };
}

/**
 * Inject the CSP into every response served to the renderer — the authoritative
 * header-based mechanism from ARCHITECTURE §2.2. Must be installed before the
 * window loads any content. Existing response headers are preserved.
 */
export function installContentSecurityPolicy(
  session: CspSessionLike,
  options: CspOptions = {},
): void {
  const policy = buildContentSecurityPolicy(options);
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
}
