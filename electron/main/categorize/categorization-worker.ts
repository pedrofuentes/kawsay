import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { log } from '../log';
import { clusterPlaces } from './places-cluster';
import { clusterThemes } from './themes-cluster';
import type {
  ClusterRequest,
  ClusterResponse,
  ClusterTransport,
} from './categorization-orchestrator';
import type { MessagePortLike, WorkerLike } from '../transcription/queue/worker-threads-transport';

// The categorization WORKER GLUE (T-M4-2g, ADR-0030 Decision 6) — the thin, structural
// seam that runs the two CPU-bound cluster passes (haversine DBSCAN places + cosine
// agglomeration themes) OFF the main thread, mirroring the transcription worker-thread
// transport. Everything here is pure or structural so a fake in-process Worker/port
// drives it in unit tests and a real worker_thread exercises the same code in prod.
//
// Only the VECTORS + coordinates cross the thread boundary (the request); theme
// LABELLING, which needs corpus text, stays on the main thread in the orchestrator.
//
// NOTE: the top-level `parentPort` entry module (and its electron-vite worker-entry
// registration) is the packaging step and is deliberately deferred to the wiring slice
// (#270) — this file ships the testable pieces: the pure runner, the inline transport,
// the worker-side binding, and the host-side worker_thread transport.

/** Host → worker: run these cluster passes. */
export interface ClusterWorkerRequest {
  readonly type: 'cluster';
  readonly request: ClusterRequest;
}

/** Worker → host: the clustered result, or a message describing a runner throw. */
export type ClusterWorkerReply =
  | { readonly type: 'result'; readonly response: ClusterResponse }
  | { readonly type: 'error'; readonly message: string };

/**
 * Run whichever cluster passes the request carries. Pure and deterministic — the single
 * point both the inline transport and the worker-side binding call, so in-process and
 * real-thread execution are byte-for-byte identical. A malformed input throws (the leaf
 * modules validate); the caller turns that into an error reply / rejected transport.
 */
export function runClusterRequest(request: ClusterRequest): ClusterResponse {
  const response: ClusterResponse = {};
  if (request.places !== undefined) {
    response.places = clusterPlaces(request.places.points, request.places.options);
  }
  if (request.themes !== undefined) {
    response.themes = clusterThemes(request.themes.items, request.themes.options);
  }
  return response;
}

/** Options for {@link createInlineClusterTransport} (the interim fix for #344). */
export interface InlineClusterTransportOptions {
  /**
   * Probe consulted at each cooperative yield point; when it returns `true` the
   * transport bails without running further passes and resolves with whatever
   * passes have already completed. The orchestrator's post-transport cancel check
   * discards partial writes, so a partial response is safe.
   */
  readonly isCancelled?: () => boolean;
  /**
   * How to surrender to the event loop between passes. Defaults to a macrotask
   * (`setImmediate`) — the ONLY primitive that lets Node service pending IPC
   * (crucially `categorize:cancel`) between slices. A microtask (`queueMicrotask`,
   * `Promise.resolve`) does NOT, so the pre-#344 wrapper starved the event loop.
   * Injected in tests to make the yield synchronous and deterministic.
   */
  readonly yield?: () => Promise<void>;
}

/** The default macrotask yield: `setImmediate` (see {@link InlineClusterTransportOptions.yield}). */
function defaultYield(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * An in-process {@link ClusterTransport} that runs the passes on the calling thread
 * but COOPERATIVELY chunks between passes so the Electron main process can service
 * pending IPC (crucially `categorize:cancel`) between slices — the interim fix for
 * #344 while the full worker-thread wiring (#269 / #270) stays deferred. The default
 * for tests (and any non-Electron caller); production wires it with a cancel probe
 * so a cancel requested mid-run stops further passes.
 *
 * Contract:
 *   - Yield once BEFORE each pass and check `isCancelled` — a cancel already set
 *     at entry skips both passes; a cancel flipped between the places and themes
 *     passes skips themes. The individual cluster leaves (`clusterPlaces`,
 *     `clusterThemes`) remain atomic — chunking inside them would require touching
 *     the deterministic algorithms and is intentionally out of scope for the interim.
 *   - When NOT cancelled the result is byte-for-byte identical to
 *     {@link runClusterRequest} (determinism preserved).
 *   - Returns a partial response on cancel; the orchestrator's post-transport
 *     `isCancelled()` check discards any partial writes.
 */
export function createInlineClusterTransport(
  options: InlineClusterTransportOptions = {},
): ClusterTransport {
  const yieldOnce = options.yield ?? defaultYield;
  const isCancelled = options.isCancelled ?? (() => false);

  return {
    async run(request) {
      const response: ClusterResponse = {};
      if (request.places !== undefined) {
        await yieldOnce();
        if (isCancelled()) return response;
        response.places = clusterPlaces(request.places.points, request.places.options);
      }
      if (request.themes !== undefined) {
        await yieldOnce();
        if (isCancelled()) return response;
        response.themes = clusterThemes(request.themes.items, request.themes.options);
      }
      return response;
    },
  };
}

/**
 * Wire the WORKER side onto a `parentPort`-like message port: on each `cluster` message
 * run the passes and post back a `result` (or an `error` reply if the runner throws, so
 * the host settles rather than hanging). The structural port makes this unit-testable
 * with a fake in-process port.
 */
export function bindClusterWorker(port: MessagePortLike): void {
  port.on('message', (value) => {
    const message = value as ClusterWorkerRequest;
    if (message.type !== 'cluster') return;
    let reply: ClusterWorkerReply;
    try {
      reply = { type: 'result', response: runClusterRequest(message.request) };
    } catch (error) {
      reply = { type: 'error', message: error instanceof Error ? error.message : String(error) };
    }
    port.postMessage(reply);
  });
}

/** Options for {@link createWorkerThreadClusterTransport} (the `createWorker` seam is the test hook). */
export interface WorkerThreadClusterTransportOptions {
  /** Absolute path to the built worker entry script. */
  readonly scriptPath: string;
  /** Spawns the worker (defaults to a real `node:worker_threads` Worker); injected in tests. */
  readonly createWorker?: (scriptPath: string) => WorkerLike;
  /**
   * The per-library cancel probe. When provided, the transport polls it while a
   * worker run is in flight and, on cancel, terminates the worker and settles the
   * run as cancelled (resolving with an empty response — a cancel is not a failure,
   * and the orchestrator's post-transport check discards the writes). Absent ⇒ no
   * polling, so the pre-#402 behavior is unchanged.
   */
  readonly isCancelled?: () => boolean;
  /**
   * How to poll {@link isCancelled} while a run is in flight: called with the poll
   * callback, returns a stop function invoked on every settle path (result / error /
   * exit / cancel) so the timer never leaks. Defaults to an unref'd `setInterval`.
   * Injected in tests to drive cancellation deterministically without real timers.
   */
  readonly startCancelPoll?: (onPoll: () => void) => () => void;
}

/** How often the default cancel poll checks {@link WorkerThreadClusterTransportOptions.isCancelled}. */
const CANCEL_POLL_INTERVAL_MS = 50;

/** The default cancel poll: an unref'd `setInterval` (see {@link WorkerThreadClusterTransportOptions.startCancelPoll}). */
function defaultStartCancelPoll(onPoll: () => void): () => void {
  const timer = setInterval(onPoll, CANCEL_POLL_INTERVAL_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
  };
}

/**
 * A {@link ClusterTransport} that runs each request on a fresh worker_thread: post the
 * request, resolve on the `result` reply, reject on an `error` reply / thread `error` /
 * premature `exit` / an unrecognized reply type, and always terminate the worker
 * afterward. One worker per run keeps the seam simple — clustering is an occasional,
 * bursty batch job, not a hot path. The unrecognized-reply guard is defensive: a
 * misbehaving worker entry (post-#270) MUST NOT be able to wedge the orchestrator's
 * drain by sending a reply the host doesn't understand.
 *
 * When an `isCancelled` probe is supplied it is polled while the run is in flight (#402):
 * a cancel requested mid-run terminates the in-flight worker and settles the run as
 * cancelled — resolving with an empty response rather than rejecting, because a cancel
 * is not a failure and the orchestrator discards any partial writes. The poll is cleared
 * on every settle path via the same `settled`/`finish()` guard, so there is no leak or
 * double-settle.
 */
export function createWorkerThreadClusterTransport(
  options: WorkerThreadClusterTransportOptions,
): ClusterTransport {
  const createWorker: (scriptPath: string) => WorkerLike =
    options.createWorker ?? ((scriptPath: string) => new Worker(scriptPath));
  const isCancelled = options.isCancelled;
  const startCancelPoll = options.startCancelPoll ?? defaultStartCancelPoll;
  return {
    run(request) {
      return new Promise<ClusterResponse>((resolve, reject) => {
        const worker = createWorker(options.scriptPath);
        let settled = false;
        let stopPoll: (() => void) | undefined;
        const finish = (act: () => void): void => {
          if (settled) return;
          settled = true;
          if (stopPoll !== undefined) stopPoll();
          worker.terminate();
          act();
        };
        if (isCancelled !== undefined) {
          stopPoll = startCancelPoll(() => {
            if (isCancelled()) finish(() => resolve({}));
          });
        }
        worker.on('message', (value) => {
          const reply = value as ClusterWorkerReply;
          if (reply.type === 'result') finish(() => resolve(reply.response));
          else if (reply.type === 'error') finish(() => reject(new Error(reply.message)));
          else {
            // Defensive: an unrecognized reply type (a malformed / incompatible worker
            // entry) MUST still settle the promise — otherwise the orchestrator's drain
            // hangs forever and every later run() returns `busy`. Terminate + reject.
            const kind =
              reply && typeof (reply as { type?: unknown }).type === 'string'
                ? (reply as { type: string }).type
                : typeof reply;
            finish(() => reject(new Error(`cluster worker sent unrecognized reply type: ${kind}`)));
          }
        });
        worker.on('error', (error) => finish(() => reject(error)));
        worker.on('exit', (code) =>
          finish(() => reject(new Error(`cluster worker exited before replying (code ${code})`))),
        );
        const message: ClusterWorkerRequest = { type: 'cluster', request };
        worker.postMessage(message);
      });
    },
  };
}

/** Options for {@link createProductionClusterTransport} (the resolver/spawn seams are the test hooks). */
export interface ProductionClusterTransportOptions {
  /** Absolute path to the built worker entry (out/main/categorization-cluster-worker.js). */
  readonly scriptPath: string;
  /**
   * The per-library cancel probe, forwarded to whichever transport is selected so a
   * cancel requested mid-run stops work: the inline fallback skips its next pass and
   * the worker transport terminates the in-flight worker (#402). The orchestrator's
   * post-transport `isCancelled()` check discards any partial writes either way.
   */
  readonly isCancelled?: () => boolean;
  /** Probe whether the built worker entry exists; defaults to `fs.existsSync`. Injected in tests. */
  readonly scriptExists?: (scriptPath: string) => boolean;
  /** Worker spawn seam forwarded to {@link createWorkerThreadClusterTransport}; injected in tests. */
  readonly createWorker?: (scriptPath: string) => WorkerLike;
  /** Cancel-poll seam forwarded to {@link createWorkerThreadClusterTransport}; injected in tests. */
  readonly startCancelPoll?: (onPoll: () => void) => () => void;
}

/**
 * The PRODUCTION {@link ClusterTransport} selector (#344): prefer the real off-thread
 * worker_thread transport when the built worker entry resolves, and degrade — lazily
 * and non-throwing, mirroring the ffmpeg/embedder degrade in `index.ts` — to the
 * in-process inline transport when it doesn't (a dev/CI checkout without a built
 * worker). A packaged build always ships the entry, so production takes the
 * off-thread path; the fallback only keeps unbuilt checkouts working.
 *
 * The degrade emits a single one-time warning (#401, #441): the selector is built once
 * per port, so a packaged build that somehow omitted the worker entry — silently
 * reintroducing MAIN-THREAD CLUSTERING (a perf-invariant violation) — is now surfaced
 * LOUDLY through the redacting logger and framed as a possible packaging regression.
 * The message carries no path or id, per the zero-egress diagnostic convention.
 */
export function createProductionClusterTransport(
  options: ProductionClusterTransportOptions,
): ClusterTransport {
  const scriptExists = options.scriptExists ?? existsSync;
  if (!scriptExists(options.scriptPath)) {
    log.warn(
      '[kawsay] categorization worker entry missing; falling back to inline main-thread clustering — expected in a dev checkout, but a possible packaging regression in a shipped build',
    );
    return createInlineClusterTransport(
      options.isCancelled === undefined ? {} : { isCancelled: options.isCancelled },
    );
  }
  return createWorkerThreadClusterTransport({
    scriptPath: options.scriptPath,
    ...(options.createWorker === undefined ? {} : { createWorker: options.createWorker }),
    ...(options.isCancelled === undefined ? {} : { isCancelled: options.isCancelled }),
    ...(options.startCancelPoll === undefined ? {} : { startCancelPoll: options.startCancelPoll }),
  });
}
