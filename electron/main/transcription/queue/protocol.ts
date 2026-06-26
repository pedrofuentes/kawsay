// The wire protocol between the main process (host) and the off-thread
// transcription worker (AC-18). This is an INTERNAL main↔worker channel — both
// ends are our own code, so messages are plain structured-clonable objects and are
// NOT zod-validated here; zod guards the renderer trust boundary instead (wired by
// #136, not this card). Keeping the protocol tiny and transport-agnostic lets the
// same coordinator/job logic run over a worker_threads MessagePort or a test fake.
// It MIRRORS the F3c ingestion harness (electron/main/importers/ingestion) so the
// two off-thread engines share one well-worn shape.

import type { TranscriptionProgress, TranscriptionBatchSummary } from '../transcribe-batch';

/** One media item to transcribe, as carried across the thread boundary (all primitives). */
export interface TranscriptionJobItem {
  /** Stable, filesystem-safe id (also the extractor's output stem). */
  id: string;
  /** Absolute LOCAL path of the source media. */
  sourcePath: string;
  /** Media duration in seconds, if known — scales the per-item timeout (AC-20). */
  durationSec?: number | null;
  /** Optional per-item language hint; otherwise the job/auto default applies. */
  language?: string;
}

/**
 * The self-contained description of one transcription BATCH run, handed to the
 * worker. Every field is a primitive (no Node handles, no open child) so it survives
 * structured clone across the thread boundary; the worker re-resolves the extractor
 * and executor from these on the far side. The model and whisper-cli paths are
 * resolved on the HOST (they need app/electron globals) and passed in as strings.
 */
export interface TranscriptionJobSpec {
  /** Correlates every progress event and the cancel request for this run. */
  jobId: string;
  /** The media items to transcribe, in order. */
  items: TranscriptionJobItem[];
  /** Absolute LOCAL path of the verified model on disk (`ggml-small.bin`). */
  modelPath: string;
  /** Absolute LOCAL path of the resolved per-arch `whisper-cli` binary. */
  whisperCliPath: string;
  /** Confined scratch root; extracted WAVs live under `<scratchDir>/transcode/`. */
  scratchDir: string;
  /** Optional batch-wide language hint applied when an item has none. */
  language?: string;
}

/** Host → worker commands. */
export type HostToWorkerMessage =
  | { type: 'start'; job: TranscriptionJobSpec }
  | { type: 'cancel' };

/** Worker → host events. `ready` resolves the spawn race (the host only sends
 *  `start` once the worker's listener is installed); terminal state is `done`
 *  (carrying the batch summary, including cooperative-cancel) or `error`. */
export type WorkerToHostMessage =
  | { type: 'ready' }
  | { type: 'progress'; progress: TranscriptionProgress }
  | { type: 'done'; summary: TranscriptionBatchSummary }
  | { type: 'error'; message: string };

/**
 * The WORKER-side transport seam: the worker posts events to the host and
 * subscribes to host commands. Implemented over worker_threads `parentPort` in
 * production and by a fake in unit tests.
 */
export interface WorkerPort {
  post(message: WorkerToHostMessage): void;
  onMessage(handler: (message: HostToWorkerMessage) => void): void;
}

/**
 * The HOST-side handle to one spawned worker: post commands, subscribe to its
 * events, observe a worker-level FAULT, and terminate it (teardown — no orphaned
 * worker on done/cancel/window close). Implemented over a worker_threads `Worker`
 * in production and by a fake in unit tests.
 */
export interface TranscriptionWorkerHandle {
  post(message: HostToWorkerMessage): void;
  onMessage(handler: (message: WorkerToHostMessage) => void): void;
  /**
   * Subscribe to a worker FAULT — an error thrown OUTSIDE the job's own try/catch
   * (a module-load failure, a native crash, OOM). Installing this listener is ALSO
   * what stops the fault from reaching the host as an `uncaughtException`, which
   * would crash the Electron main process.
   */
  onError(handler: (error: Error) => void): void;
  /**
   * Subscribe to worker termination (`code` is the OS exit code, 0 = clean). An
   * exit that arrives before a terminal `done`/`error` message is an abnormal
   * teardown (native abort, OOM kill, `process.exit`) that would otherwise orphan
   * the handle and hang the batch forever.
   */
  onExit(handler: (code: number) => void): void;
  /** Fire-and-forget teardown (the return — sync or a Promise — is ignored). */
  terminate(): unknown;
}

/** Spawns a fresh worker handle for one batch (injected so the coordinator is
 *  transport-agnostic and unit-testable without a real thread). */
export type SpawnTranscriptionWorker = () => TranscriptionWorkerHandle;
