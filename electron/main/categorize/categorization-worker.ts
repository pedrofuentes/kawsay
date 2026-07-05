import { Worker } from 'node:worker_threads';
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

/**
 * An in-process {@link ClusterTransport} that runs the passes synchronously on the
 * calling thread. The default for tests (and any non-Electron caller); production
 * injects {@link createWorkerThreadClusterTransport} instead.
 */
export function createInlineClusterTransport(): ClusterTransport {
  return { run: (request) => Promise.resolve(runClusterRequest(request)) };
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
 * premature `exit`, and always terminate the worker afterward. One worker per run keeps
 * the seam simple — clustering is an occasional, bursty batch job, not a hot path.
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
