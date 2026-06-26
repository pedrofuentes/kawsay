// The production {@link ModelFetcher}: a thin adapter over Electron's
// `net.request`, bound to the GUARDED `session`. This is the load-bearing
// privacy choice — issuing the model download through Electron's network stack
// (not Node `http`/`https`) means every request and every followed redirect
// passes through `network-guard.ts`'s `session.webRequest.onBeforeRequest`
// chokepoint, where the scoped allowlist (see `isAllowedModelDownloadRequest`)
// is the only thing that lets it out. A Node-socket downloader would bypass the
// guard entirely and silently break "your memories never leave this computer".
//
// Electron is referenced ONLY through the structural `ElectronNetLike` subset
// below, so this module type-checks and unit-tests with a fake `net` and never
// imports the Electron runtime (the real `net`/`session` are injected from the
// composition root in electron/main/index.ts).

import type {
  ModelFetchRequest,
  ModelFetchResponse,
  ModelFetcher,
} from './model-download';

/** A streamed response body chunk handler — Electron delivers Node `Buffer`s. */
type DataListener = (chunk: Uint8Array) => void;

/**
 * Structural subset of Electron's `IncomingMessage`. Note it is an EventEmitter,
 * NOT a Node Readable — it has no `pause`/`resume`/async-iterator — so the body
 * is consumed via `data`/`end`/`error`/`aborted` events and bridged to an
 * {@link AsyncIterable} here.
 */
export interface ElectronIncomingMessageLike {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[]>>;
  on(event: 'data', listener: DataListener): ElectronIncomingMessageLike;
  on(event: 'end' | 'aborted', listener: () => void): ElectronIncomingMessageLike;
  on(event: 'error', listener: (error: Error) => void): ElectronIncomingMessageLike;
}

/** Structural subset of Electron's `ClientRequest`. */
export interface ElectronClientRequestLike {
  setHeader(name: string, value: string): void;
  on(
    event: 'response',
    listener: (response: ElectronIncomingMessageLike) => void,
  ): ElectronClientRequestLike;
  on(event: 'error', listener: (error: Error) => void): ElectronClientRequestLike;
  end(): void;
  abort(): void;
}

/** The `net.request` options we set (structural subset of Electron's options).
 *  Generic over the session type so the composition root binds Electron's real
 *  `Session` while tests pass a lightweight fake. */
export interface ElectronNetRequestOptions<TSession = unknown> {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Record<string, string | string[]>;
  readonly session?: TSession;
  readonly redirect?: 'follow' | 'error' | 'manual';
  readonly credentials?: 'include' | 'omit' | 'same-origin';
}

/** Structural subset of Electron's `net` (just `request`). */
export interface ElectronNetLike<TSession = unknown> {
  request(options: ElectronNetRequestOptions<TSession>): ElectronClientRequestLike;
}

/**
 * Default high-water mark (bytes) for the in-memory body queue: 16 MiB. Electron's
 * `IncomingMessage` has no `pause`/`resume`, so on a fast-net/slow-disk machine an
 * unbounded queue could grow toward the whole ~466 MiB body and OOM a low-RAM
 * machine (our audience). 16 MiB caps the worst-case spike while staying far above
 * a single socket read, so backpressure aborts are rare and each resume still
 * transfers a large, efficient run before the next (if any) pause.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

/** Tuning for {@link toAsyncIterable}'s bounded, backpressure-aware queue. */
interface ToAsyncIterableOptions {
  /** Max bytes allowed to sit un-drained in the queue before backpressure trips. */
  readonly maxBufferedBytes: number;
  /**
   * Called once the queue would exceed {@link maxBufferedBytes}. Electron's body
   * stream cannot be paused, so the only lever is to ABORT the request; the
   * download manager then resumes from the on-disk offset via HTTP `Range`.
   */
  readonly onBackpressure: () => void;
}

/**
 * Bridge an event-based Electron `IncomingMessage` into an ordered, error-aware
 * {@link AsyncIterable}. Listeners are attached eagerly (when the response
 * arrives) so a `data` event that fires before the consumer starts iterating is
 * queued rather than lost.
 *
 * Electron's `IncomingMessage` exposes NO backpressure primitive (no
 * `pause`/`resume`), so if the disk lags the network the queue would otherwise
 * grow without bound — a real OOM risk on the ~466 MiB model. Instead the queue
 * is BOUNDED: once buffering another chunk would exceed `maxBufferedBytes` we stop
 * accumulating, fire `onBackpressure` (which aborts the request), and surface a
 * retryable signal AFTER the already-queued bytes drain. The download manager
 * banks those bytes and resumes from the on-disk offset via HTTP `Range`, so peak
 * memory stays bounded with integrity (SHA-256) intact.
 */
function toAsyncIterable(
  message: ElectronIncomingMessageLike,
  options: ToAsyncIterableOptions,
): AsyncIterable<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let queuedBytes = 0;
  let ended = false;
  let failure: Error | undefined;
  let backpressured = false;
  let wake: (() => void) | undefined;

  const signal = (): void => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  message.on('data', (chunk) => {
    // Already over the mark and aborting: drop further chunks. They are not lost —
    // the resume re-requests them from the on-disk offset via `Range`.
    if (backpressured) {
      return;
    }
    // Accept the chunk only while the queue stays within the high-water mark, but
    // always accept when the queue is empty so a single oversized chunk still makes
    // forward progress (never a resume that can't advance).
    if (queuedBytes > 0 && queuedBytes + chunk.length > options.maxBufferedBytes) {
      backpressured = true;
      // Surface AFTER the queued prefix drains (the iterator checks `failure` only
      // once `chunks` is empty), so banked bytes reach disk before the resume.
      failure ??= new Error(
        'model download paused: response buffer high-water mark exceeded (resuming via Range)',
      );
      options.onBackpressure();
      signal();
      return;
    }
    chunks.push(chunk);
    queuedBytes += chunk.length;
    signal();
  });
  message.on('end', () => {
    ended = true;
    signal();
  });
  message.on('error', (error) => {
    failure = error;
    signal();
  });
  message.on('aborted', () => {
    failure ??= new Error('the model download connection was aborted');
    signal();
  });

  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      for (;;) {
        const next = chunks.shift();
        if (next !== undefined) {
          queuedBytes -= next.length;
          yield next;
          continue;
        }
        if (failure) {
          throw failure;
        }
        if (ended) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/** Tuning for the production model fetcher. */
export interface ElectronModelFetcherOptions {
  /**
   * High-water mark (bytes) for the in-memory body queue before backpressure
   * aborts the request and the download resumes via `Range`. Defaults to
   * {@link DEFAULT_MAX_BUFFERED_BYTES} (16 MiB).
   */
  readonly maxBufferedBytes?: number;
}

/**
 * Create the production model fetcher. `net` and `session` are injected so the
 * adapter is Electron-free at the type level and testable with a fake `net`; the
 * composition root passes the real `net` and the GUARDED `session.defaultSession`.
 */
export function createElectronModelFetcher<TSession = unknown>(
  net: ElectronNetLike<TSession>,
  session: TSession,
  options: ElectronModelFetcherOptions = {},
): ModelFetcher {
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  return (request: ModelFetchRequest): Promise<ModelFetchResponse> =>
    new Promise<ModelFetchResponse>((resolve, reject) => {
      const clientRequest = net.request({
        url: request.url,
        method: request.method,
        session,
        // Follow GitHub's 302 from the pinned origin to the signed CDN natively,
        // so each hop re-enters the webRequest guard.
        redirect: 'follow',
        // Never attach cookies/auth from the session: the release asset is public
        // and the download must carry nothing that could identify the user.
        credentials: 'omit',
      });

      for (const [name, value] of Object.entries(request.headers)) {
        clientRequest.setHeader(name, value);
      }

      clientRequest.on('response', (response) => {
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: toAsyncIterable(response, {
            maxBufferedBytes,
            // No `pause`/`resume` on Electron's body — abort and let the download
            // manager resume from the on-disk offset via HTTP `Range`.
            onBackpressure: () => {
              clientRequest.abort();
            },
          }),
          cancel: () => {
            clientRequest.abort();
          },
        });
      });
      clientRequest.on('error', (error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      clientRequest.end();
    });
}
