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
  const handles = new Map<string, IngestionWorkerHandle>();

  function teardown(jobId: string): void {
    const handle = handles.get(jobId);
    if (handle === undefined) return;
    handles.delete(jobId);
    void handle.terminate();
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
        emitProgress(errorEvent(job.jobId, message.message));
        teardown(job.jobId);
        return;
    }
  }

  return {
    start(job) {
      const handle = spawn();
      handles.set(job.jobId, handle);
      handle.onMessage((message) => onMessage(job, handle, message));
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
