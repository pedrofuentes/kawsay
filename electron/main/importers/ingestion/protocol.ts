// The wire protocol between the main process (host) and the off-thread
// ingestion worker (AC-9). This is an INTERNAL main↔worker channel — both ends
// are our own code, so messages are plain structured-clonable objects and are
// NOT zod-validated here; zod guards the two TRUST boundaries instead (the
// renderer↔preload IPC surface and the preload↔main invoke). Keeping the
// protocol tiny and transport-agnostic lets the same coordinator/job logic run
// over a worker_threads MessagePort, an Electron utilityProcess, or a test fake.

import type { SourceType } from '@shared/catalog';
import type { ImportProgress } from '../types';
import type { IngestionSummary } from '../ingest';

/**
 * The self-contained description of one import run, handed to the worker. Every
 * field is a primitive (no Node handles, no open db) so it survives structured
 * clone across the thread boundary; the worker re-opens the catalog and resolves
 * the importer from these on the far side.
 */
export interface IngestionJobSpec {
  /** Correlates every progress event and the cancel request for this run. */
  jobId: string;
  sourceType: SourceType;
  inputPath: string;
  /** Absolute library root (putOriginal + derived renditions land under it). */
  libraryRoot: string;
  /** Absolute on-disk SQLite path the worker opens (never sent to the renderer). */
  catalogPath: string;
  /** The `sources` row id this run writes occurrences against. */
  sourceId: string;
  /** Per-import scratch dir forwarded to the importer. */
  workDir: string;
}

/** Host → worker commands. */
export type HostToWorkerMessage =
  | { type: 'start'; job: IngestionJobSpec }
  | { type: 'cancel' };

/** Worker → host events. `ready` resolves the spawn race (the host only sends
 *  `start` once the worker's listener is installed); terminal state is `done`
 *  (carrying the summary, including cooperative-cancel) or `error`. */
export type WorkerToHostMessage =
  | { type: 'ready' }
  | { type: 'progress'; progress: ImportProgress }
  | { type: 'done'; summary: IngestionSummary }
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
 * events, and terminate it (teardown — no orphaned worker on done/cancel/window
 * close). Implemented over a worker_threads `Worker` in production and by a fake
 * in unit tests.
 */
export interface IngestionWorkerHandle {
  post(message: HostToWorkerMessage): void;
  onMessage(handler: (message: WorkerToHostMessage) => void): void;
  terminate(): void | Promise<unknown>;
}

/** Spawns a fresh worker handle for one job (injected so the coordinator is
 *  transport-agnostic and unit-testable without a real thread). */
export type SpawnIngestionWorker = () => IngestionWorkerHandle;
