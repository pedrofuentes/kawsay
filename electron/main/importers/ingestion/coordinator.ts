// Host-side orchestration of off-thread imports (AC-9). The coordinator owns the
// worker lifecycle for every in-flight job: it spawns a worker, waits for its
// `ready` handshake before sending the job, relays the worker's progress/done/
// error onto the renderer-facing `import:progress` event, forwards cooperative
// cancels, and ALWAYS terminates the worker on a terminal event, on an explicit
// cancel-to-completion, or on dispose — so no worker is ever orphaned.
//
// Every collaborator is injected (the spawner and the progress emitter), so the
// whole thing is unit-testable with a fake worker and no real thread.

import type { ImportProgressEvent } from '@shared/ipc/events';
import type { IngestionSummary } from '../ingest';
import type { ImportProgress } from '../types';
import type {
  IngestionJobSpec,
  IngestionWorkerHandle,
  SpawnIngestionWorker,
  WorkerToHostMessage,
} from './protocol';

export interface IngestionCoordinatorOptions {
  /** Creates a fresh worker handle for each job. */
  spawn: SpawnIngestionWorker;
  /** Sinks one renderer-facing progress event (the validated event sender). */
  emitProgress: (event: ImportProgressEvent) => void;
  /** Main-process diagnostic sink for worker faults. Defaults to console.error. */
  logWorkerFault?: (error: Error) => void;
}

/**
 * A worker FAULT observed via the worker_threads `error`/`exit` lifecycle — a
 * crash OUTSIDE the job's own try/catch (a module-load failure, a native abort
 * in better-sqlite3/exifr/ffmpeg, OOM, or a rogue `process.exit`). The worker
 * never gets to post a terminal `done`/`error` message, so the coordinator
 * surfaces this to the renderer as a terminal `import:progress` error and tears
 * the worker down — the import settles with a typed failure instead of hanging.
 */
/**
 * The ONE safe, renderer-facing copy for ANY ingestion worker failure — a lifecycle
 * fault (crash/exit) OR a job `error` message. It NEVER carries the raw worker error
 * text (a filesystem path, a parse detail, or item content, #440); the raw message
 * goes only to the local diagnostic sink. Both fault paths deliver this same string,
 * so the renderer's import-error copy is consistent and leak-free.
 */
export const WORKER_FAILURE_RENDERER_MESSAGE = 'ingestion worker crashed before completing';

export class IngestionWorkerFaultError extends Error {
  readonly rendererMessage: string;

  constructor(message: string, rendererMessage = WORKER_FAILURE_RENDERER_MESSAGE) {
    super(message);
    this.name = 'IngestionWorkerFaultError';
    this.rendererMessage = rendererMessage;
  }
}

function preserveFaultStack(error: Error, prefix: string): IngestionWorkerFaultError {
  const fault = new IngestionWorkerFaultError(`${prefix}: ${error.message}`);
  fault.stack = error.stack;
  return fault;
}

export interface IngestionCoordinator {
  /** Spawn a worker and run `job` off-thread; events stream via `emitProgress`. */
  start(job: IngestionJobSpec): void;
  /** Cooperatively cancel an in-flight job. Returns false if it isn't running. */
  cancel(jobId: string): boolean;
  /** Terminate every in-flight worker (window-close / app-quit teardown). */
  disposeAll(): void;
  /** The job ids currently running (for teardown assertions). */
  active(): string[];
}

function progressEvent(jobId: string, progress: ImportProgress): ImportProgressEvent {
  return {
    jobId,
    phase: progress.phase,
    processed: progress.processed,
    total: progress.total,
    message: progress.message,
    summary: null,
    error: null,
  };
}

function doneEvent(jobId: string, summary: IngestionSummary): ImportProgressEvent {
  return {
    jobId,
    phase: 'done',
    processed: summary.recordCount,
    total: summary.recordCount,
    message: null,
    summary,
    error: null,
  };
}

function errorEvent(jobId: string, message: string): ImportProgressEvent {
  return {
    jobId,
    phase: 'done',
    processed: 0,
    total: null,
    message: null,
    summary: null,
    error: message,
  };
}

export function createIngestionCoordinator(
  options: IngestionCoordinatorOptions,
): IngestionCoordinator {
  const { spawn, emitProgress } = options;
  const logWorkerFault =
    options.logWorkerFault ??
    ((error: Error) => {
      console.error(error.stack ?? error.message);
    });
  const handles = new Map<string, IngestionWorkerHandle>();

  function teardown(jobId: string): void {
    const handle = handles.get(jobId);
    if (handle === undefined) return;
    // Delete BEFORE terminate so the worker's own 'exit' (which terminate emits)
    // arrives with the job already forgotten and is ignored as a graceful close.
    handles.delete(jobId);
    void handle.terminate();
  }

  // Settle an import whose worker faulted via the worker_threads `error`/`exit`
  // events (no terminal message). Guarded on `handles.has` so it fires at most
  // once per job and NEVER on the post-teardown 'exit' that follows a graceful
  // done/cancel — that exit arrives after teardown removed the handle.
  function settleFault(jobId: string, fault: IngestionWorkerFaultError): void {
    if (!handles.has(jobId)) return;
    logWorkerFault(fault);
    emitProgress(errorEvent(jobId, fault.rendererMessage));
    teardown(jobId);
  }

  function onMessage(job: IngestionJobSpec, handle: IngestionWorkerHandle, message: WorkerToHostMessage): void {
    switch (message.type) {
      case 'ready':
        // Handshake complete — the worker's listener is installed, so it's safe
        // to hand it the job without racing the spawn.
        handle.post({ type: 'start', job });
        return;
      case 'progress':
        emitProgress(progressEvent(job.jobId, message.progress));
        return;
      case 'done':
        emitProgress(doneEvent(job.jobId, message.summary));
        teardown(job.jobId);
        return;
      case 'error':
        // A job-level failure the worker caught and reported. Mirror `settleFault`:
        // the RAW worker message (which can embed a path / parse detail / item text)
        // goes ONLY to the local diagnostic sink — the renderer-facing event carries
        // the safe fixed copy, never the raw string (#440).
        logWorkerFault(new Error(message.message));
        emitProgress(errorEvent(job.jobId, WORKER_FAILURE_RENDERER_MESSAGE));
        teardown(job.jobId);
        return;
    }
  }

  return {
    start(job) {
      const handle = spawn();
      handles.set(job.jobId, handle);
      handle.onMessage((message) => onMessage(job, handle, message));
      // A fault outside the worker's job try/catch surfaces as a worker_threads
      // 'error'/'exit' EVENT, never a protocol message. Observing both keeps a
      // crash off the main process and stops an abnormal exit orphaning the handle.
      handle.onError((error) =>
        settleFault(job.jobId, preserveFaultStack(error, 'ingestion worker crashed')),
      );
      handle.onExit((code) =>
        settleFault(
          job.jobId,
          new IngestionWorkerFaultError(`ingestion worker exited before completing (code ${String(code)})`),
        ),
      );
    },
    cancel(jobId) {
      const handle = handles.get(jobId);
      if (handle === undefined) return false;
      // Cooperative: the worker aborts its AbortSignal, runIngestion stops at the
      // next record and returns a partial summary (cancelled=true), which arrives
      // as a normal `done` — that's what tears the worker down.
      handle.post({ type: 'cancel' });
      return true;
    },
    disposeAll() {
      for (const jobId of [...handles.keys()]) teardown(jobId);
    },
    active() {
      return [...handles.keys()];
    },
  };
}
