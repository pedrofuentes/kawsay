import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
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
}

/**
 * A {@link ClusterTransport} that runs each request on a fresh worker_thread: post the
 * request, resolve on the `result` reply, reject on an `error` reply / thread `error` /
 * premature `exit` / an unrecognized reply type, and always terminate the worker
 * afterward. One worker per run keeps the seam simple — clustering is an occasional,
 * bursty batch job, not a hot path. The unrecognized-reply guard is defensive: a
 * misbehaving worker entry (post-#270) MUST NOT be able to wedge the orchestrator's
 * drain by sending a reply the host doesn't understand.
 */
export function createWorkerThreadClusterTransport(
  options: WorkerThreadClusterTransportOptions,
): ClusterTransport {
  const createWorker: (scriptPath: string) => WorkerLike =
    options.createWorker ?? ((scriptPath: string) => new Worker(scriptPath));
  return {
    run(request) {
      return new Promise<ClusterResponse>((resolve, reject) => {
        const worker = createWorker(options.scriptPath);
        let settled = false;
        const finish = (act: () => void): void => {
          if (settled) return;
          settled = true;
          worker.terminate();
          act();
        };
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
   * The per-library cancel probe, forwarded to the inline fallback so a cancel
   * requested mid-run still stops the next pass when no worker is available. The
   * worker transport does NOT need it — the main thread stays responsive off-thread
   * and the orchestrator's post-transport `isCancelled()` check discards any writes.
   */
  readonly isCancelled?: () => boolean;
  /** Probe whether the built worker entry exists; defaults to `fs.existsSync`. Injected in tests. */
  readonly scriptExists?: (scriptPath: string) => boolean;
  /** Worker spawn seam forwarded to {@link createWorkerThreadClusterTransport}; injected in tests. */
  readonly createWorker?: (scriptPath: string) => WorkerLike;
}

/**
 * The PRODUCTION {@link ClusterTransport} selector (#344): prefer the real off-thread
 * worker_thread transport when the built worker entry resolves, and degrade — lazily
 * and non-throwing, mirroring the ffmpeg/embedder degrade in `index.ts` — to the
 * in-process inline transport when it doesn't (a dev/CI checkout without a built
 * worker). A packaged build always ships the entry, so production takes the
 * off-thread path; the fallback only keeps unbuilt checkouts working.
 */
export function createProductionClusterTransport(
  options: ProductionClusterTransportOptions,
): ClusterTransport {
  const scriptExists = options.scriptExists ?? existsSync;
  if (!scriptExists(options.scriptPath)) {
    return createInlineClusterTransport(
      options.isCancelled === undefined ? {} : { isCancelled: options.isCancelled },
    );
  }
  return createWorkerThreadClusterTransport(
    options.createWorker === undefined
      ? { scriptPath: options.scriptPath }
      : { scriptPath: options.scriptPath, createWorker: options.createWorker },
  );
}
