// Host-side orchestration of off-thread transcription (AC-18). The coordinator owns
// the worker lifecycle for every in-flight batch: it spawns a worker, waits for its
// `ready` handshake before sending the job, relays the worker's progress/done/error
// onto an injected sink, forwards cooperative cancels, and ALWAYS terminates the
// worker on a terminal event, on an explicit cancel-to-completion, or on dispose — so
// no worker is ever orphaned. It MIRRORS the F3c ingestion coordinator.
//
// Crucially it stays IPC-AGNOSTIC: it emits a typed coordinator event rather than a
// renderer-facing `*:progress` event, because wiring the renderer IPC channel is a
// LATER card (#136), not this one. #136 adapts `emit` to a validated IPC sender.
//
// Every collaborator is injected (the spawner and the event sink), so the whole thing
// is unit-testable with a fake worker and no real thread.

import type {
  SpawnTranscriptionWorker,
  TranscriptionJobSpec,
  TranscriptionWorkerHandle,
  WorkerToHostMessage,
} from './protocol';
import type { TranscriptionBatchSummary, TranscriptionProgress } from '../transcribe-batch';

/** A typed, IPC-agnostic event the coordinator emits for one job (#136 adapts it to IPC). */
export type TranscriptionCoordinatorEvent =
  | { jobId: string; kind: 'progress'; progress: TranscriptionProgress }
  | { jobId: string; kind: 'done'; summary: TranscriptionBatchSummary }
  | { jobId: string; kind: 'error'; message: string };

export interface TranscriptionCoordinatorOptions {
  /** Creates a fresh worker handle for each batch. */
  spawn: SpawnTranscriptionWorker;
  /** Sinks one coordinator event (relayed progress + terminal done/error). */
  emit: (event: TranscriptionCoordinatorEvent) => void;
}

/**
 * A worker FAULT observed via the worker_threads `error`/`exit` lifecycle — a crash
 * OUTSIDE the job's own try/catch (a module-load failure, a native abort, OOM, or a
 * rogue `process.exit`). The worker never gets to post a terminal `done`/`error`
 * message, so the coordinator surfaces this as a terminal error event and tears the
 * worker down — the batch settles with a typed failure instead of hanging.
 */
export class TranscriptionWorkerFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptionWorkerFaultError';
  }
}

export interface TranscriptionCoordinator {
  /** Spawn a worker and run `job` off-thread; events stream via `emit`. */
  start(job: TranscriptionJobSpec): void;
  /** Cooperatively cancel an in-flight batch. Returns false if it isn't running. */
  cancel(jobId: string): boolean;
  /** Terminate every in-flight worker (window-close / app-quit teardown). */
  disposeAll(): void;
  /** The job ids currently running (for teardown assertions). */
  active(): string[];
}

export function createTranscriptionCoordinator(
  options: TranscriptionCoordinatorOptions,
): TranscriptionCoordinator {
  const { spawn, emit } = options;
  const handles = new Map<string, TranscriptionWorkerHandle>();

  function teardown(jobId: string): void {
    const handle = handles.get(jobId);
    if (handle === undefined) return;
    // Delete BEFORE terminate so the worker's own 'exit' (which terminate emits)
    // arrives with the job already forgotten and is ignored as a graceful close.
    handles.delete(jobId);
    void handle.terminate();
  }

  // Settle a batch whose worker faulted via the worker_threads `error`/`exit` events
  // (no terminal message). Guarded on `handles.has` so it fires at most once per job
  // and NEVER on the post-teardown 'exit' that follows a graceful done/cancel — that
  // exit arrives after teardown removed the handle.
  function settleFault(jobId: string, fault: TranscriptionWorkerFaultError): void {
    if (!handles.has(jobId)) return;
    emit({ jobId, kind: 'error', message: fault.message });
    teardown(jobId);
  }

  function onMessage(
    job: TranscriptionJobSpec,
    handle: TranscriptionWorkerHandle,
    message: WorkerToHostMessage,
  ): void {
    switch (message.type) {
      case 'ready':
        // Handshake complete — the worker's listener is installed, so it's safe to
        // hand it the job without racing the spawn.
        handle.post({ type: 'start', job });
        return;
      case 'progress':
        emit({ jobId: job.jobId, kind: 'progress', progress: message.progress });
        return;
      case 'done':
        emit({ jobId: job.jobId, kind: 'done', summary: message.summary });
        teardown(job.jobId);
        return;
      case 'error':
        emit({ jobId: job.jobId, kind: 'error', message: message.message });
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
      // 'error'/'exit' EVENT, never a protocol message. Observing both keeps a crash
      // off the main process and stops an abnormal exit orphaning the handle.
      handle.onError((error) =>
        settleFault(
          job.jobId,
          new TranscriptionWorkerFaultError(`transcription worker crashed: ${error.message}`),
        ),
      );
      handle.onExit((code) =>
        settleFault(
          job.jobId,
          new TranscriptionWorkerFaultError(
            `transcription worker exited before completing (code ${String(code)})`,
          ),
        ),
      );
    },
    cancel(jobId) {
      const handle = handles.get(jobId);
      if (handle === undefined) return false;
      // Cooperative: the worker aborts its AbortSignal, which the executor forwards
      // to the in-flight whisper-cli child (SIGKILL) and the batch stops dispatching;
      // the partial, cancelled summary arrives as a normal `done` — that tears down.
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
