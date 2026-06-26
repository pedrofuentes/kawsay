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
 * Bridge an event-based Electron `IncomingMessage` into an ordered, error-aware
 * {@link AsyncIterable}. Listeners are attached eagerly (when the response
 * arrives) so a `data` event that fires before the consumer starts iterating is
 * queued rather than lost. Electron's `IncomingMessage` exposes no backpressure
 * primitive, so chunks queue in memory if the disk lags the network; in practice
 * the network is the bottleneck for the ~466 MiB model, keeping the queue small.
 */
function toAsyncIterable(message: ElectronIncomingMessageLike): AsyncIterable<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let ended = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;

  const signal = (): void => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  message.on('data', (chunk) => {
    chunks.push(chunk);
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

/**
 * Create the production model fetcher. `net` and `session` are injected so the
 * adapter is Electron-free at the type level and testable with a fake `net`; the
 * composition root passes the real `net` and the GUARDED `session.defaultSession`.
 */
export function createElectronModelFetcher<TSession = unknown>(
  net: ElectronNetLike<TSession>,
  session: TSession,
): ModelFetcher {
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
          body: toAsyncIterable(response),
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
