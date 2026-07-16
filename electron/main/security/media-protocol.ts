// The hardened `kawsay-media:` protocol handler (#428) — the ONLY path media bytes
// take to the renderer, and deny-by-default at every step.
//
//   • A URL carries EXACTLY one opaque catalog id (`z.uuid()`). A path, a traversal
//     string, an extra segment, a query, or the wrong host/scheme never validates —
//     so the renderer can never name (or smuggle) a filesystem path.
//   • The id is resolved SERVER-SIDE to a confined originals-store file (via the
//     injected resolver, which throws on an escaping content-address). A resolve
//     that yields nothing — or throws — answers a 4xx and streams NOT ONE byte.
//   • A resolvable memory streams its LOCAL file with the right content-type,
//     `Accept-Ranges: bytes`, and HTTP range support (206) for video seeking. The
//     handler reads a local file only; it opens no socket (AC-4).
//
// Pure Web + Node primitives (Request-shape in, `Response` out, `node:fs` streams),
// no Electron import — so the whole serving path unit-tests under Vitest. The tiny
// Electron-specific wiring (registerSchemesAsPrivileged + protocol.handle) lives in
// the composition root (`electron/main/index.ts`).
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { MEDIA_PROTOCOL_SCHEME, MEDIA_URL_HOST } from '@shared/media';

/** The privileges the scheme registers with (before app-ready). `bypassCSP:false`
 *  is load-bearing: media still flows THROUGH the locked-down CSP, admitted only by
 *  the narrow `media-src`/`img-src kawsay-media:` allowance. `standard`+`stream`
 *  give it origin semantics + range-streaming; nothing here is networked. */
export const MEDIA_PROTOCOL_PRIVILEGES = {
  standard: true,
  secure: true,
  stream: true,
  supportFetchAPI: true,
  bypassCSP: false,
  corsEnabled: false,
} as const;

/** The opaque catalog id an incoming URL must carry — a uuid, so a path/traversal
 *  string can never validate (mirrors the `catalog:*` channels' `z.uuid()`). */
const mediaIdSchema = z.uuid();

/** A resolved, confined media file ready to stream (the handler needs only these). */
export interface ResolvedMedia {
  absPath: string;
  mimeType: string;
}

/** Structural view of the request the handler reads — Electron's protocol `Request`
 *  satisfies it, and a test can pass a tiny stand-in (no Electron needed). */
export interface MediaRequestLike {
  readonly url: string;
  readonly headers: { get(name: string): string | null };
}

export interface MediaProtocolHandlerOptions {
  /** Resolve an opaque id → a confined file, or null. May THROW on a confinement
   *  rejection; the handler turns that into a 404 (never reads outside the store). */
  resolve: (id: string) => ResolvedMedia | null;
  /**
   * Privacy-preserving sink for a REJECTED serve (a confinement throw or a mid-stream
   * read failure). Receives ONLY `{ name, code }` — never a filesystem path or the
   * raw error — so a security event is observable in logs without leaking a path.
   */
  onRejected?: (info: { name: string; code?: string }) => void;
}

/** Reduce any thrown value to a privacy-preserving `{ name, code }` (no message, no
 *  path, no stack) — mirrors the `diagnosticError` helpers elsewhere in main. */
function diagnosticError(error: unknown): { name: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { name: error.name, code: typeof code === 'string' ? code : undefined };
  }
  return { name: 'UnknownError' };
}

/**
 * Extract the single opaque uuid from a `kawsay-media://item/<uuid>` URL, or null
 * for anything else — a non-uuid id, a traversal string, extra path segments, a
 * query/fragment, the wrong host, or the wrong scheme. Deny-by-default: an
 * unparseable URL is null.
 */
export function parseMediaId(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${MEDIA_PROTOCOL_SCHEME}:`) return null;
  if (parsed.hostname !== MEDIA_URL_HOST) return null;
  // A media URL is exactly host + one id segment: no query, no fragment, no extras.
  if (parsed.search !== '' || parsed.hash !== '') return null;
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  if (segments.length !== 1) return null;
  const result = mediaIdSchema.safeParse(segments[0]);
  return result.success ? result.data : null;
}

/** A parsed, in-bounds byte range (inclusive), or null to serve the whole file. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse an HTTP `Range` header against a known file `size` for video seeking.
 * Supports `bytes=start-end`, open-ended `bytes=start-`, and suffix `bytes=-N`.
 * Returns null (⇒ a full 200 response) when there is no header, it is malformed,
 * or the range is unsatisfiable.
 */
export function parseRangeHeader(header: string | null, size: number): ByteRange | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) return null;
  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';
  if (startRaw === '' && endRaw === '') return null;

  let start: number;
  let end: number;
  if (startRaw === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(endRaw);
    if (suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1);
  }
  if (start < 0 || start >= size || start > end) return null;
  return { start, end };
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

/**
 * Build the `kawsay-media:` protocol handler. The returned function takes an
 * (Electron) protocol request and resolves to a `Response`: a 400 for a malformed
 * id, a 404 for an unresolvable/escaping/missing file, or a 200/206 stream of the
 * confined local original with the correct headers.
 */
export function createMediaProtocolHandler(
  options: MediaProtocolHandlerOptions,
): (request: MediaRequestLike) => Promise<Response> {
  return async function handle(request: MediaRequestLike): Promise<Response> {
    const id = parseMediaId(request.url);
    if (id === null) return emptyResponse(400);

    let media: ResolvedMedia | null;
    try {
      media = options.resolve(id);
    } catch (error) {
      // A confinement rejection (an escaping content-address, or an in-place file
      // whose realpath escapes its source root) is refused BEFORE any read — surfaced
      // as a plain not-found, never a path or error to the renderer, and logged with
      // a privacy-preserving diagnostic so the security event stays observable.
      options.onRejected?.(diagnosticError(error));
      return emptyResponse(404);
    }
    if (media === null) return emptyResponse(404);

    let size: number;
    try {
      const stats = await stat(media.absPath);
      if (!stats.isFile()) return emptyResponse(404);
      size = stats.size;
    } catch {
      return emptyResponse(404);
    }

    const range = parseRangeHeader(request.headers.get('range'), size);
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(size - 1, 0);
    const length = size === 0 ? 0 : end - start + 1;

    let body: ReadableStream<Uint8Array> | null = null;
    if (length > 0) {
      const nodeStream = createReadStream(media.absPath, { start, end });
      // A mid-stream read failure (file truncated/removed while streaming) must be
      // HANDLED, not crash the process: log a privacy-preserving diagnostic and let
      // the web stream surface the error to the media element (a graceful load fail).
      nodeStream.on('error', (error) => {
        options.onRejected?.(diagnosticError(error));
      });
      body = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
    }

    const headers = new Headers({
      'Content-Type': media.mimeType,
      'Content-Length': String(length),
      'Accept-Ranges': 'bytes',
      // The id→bytes mapping is stable and local; a private cache is safe (no egress).
      'Cache-Control': 'no-cache',
    });
    if (range !== null) {
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      return new Response(body, { status: 206, headers });
    }
    return new Response(body, { status: 200, headers });
  };
}
