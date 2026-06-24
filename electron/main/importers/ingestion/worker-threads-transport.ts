// worker_threads transport adapters — the thin glue that binds the transport-
// agnostic coordinator/job onto a real OS worker thread (AC-9). worker_threads
// (rather than utilityProcess) keeps heavy ingestion off the UI thread while
// remaining fully unit-testable: every adapter is structural, so a fake
// Worker/MessagePort drives them in-process, and a real thread exercises the
// same code end-to-end. Both directions are raw structured-clone messages.

import { Worker } from 'node:worker_threads';
import type {
  HostToWorkerMessage,
  IngestionWorkerHandle,
  SpawnIngestionWorker,
  WorkerPort,
  WorkerToHostMessage,
} from './protocol';

/** The slice of a worker_threads `MessagePort`/`parentPort` we depend on. */
export interface MessagePortLike {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (value: unknown) => void): void;
}

/** The slice of a worker_threads `Worker` we depend on (a port plus terminate). */
export interface WorkerLike extends MessagePortLike {
  terminate(): Promise<unknown> | unknown;
}

/** Host-side handle over a worker_threads `Worker`. */
export function createWorkerThreadsHostHandle(worker: WorkerLike): IngestionWorkerHandle {
  return {
    post: (message) => worker.postMessage(message),
    onMessage: (handler) =>
      worker.on('message', (value) => handler(value as WorkerToHostMessage)),
    terminate: () => worker.terminate(),
  };
}

/** Worker-side port over the worker_threads `parentPort`. */
export function createParentPortWorkerPort(parentPort: MessagePortLike): WorkerPort {
  return {
    post: (message) => parentPort.postMessage(message),
    onMessage: (handler) =>
      parentPort.on('message', (value) => handler(value as HostToWorkerMessage)),
  };
}

export interface WorkerThreadsSpawnerOptions {
  /** Absolute path to the built worker entry (out/main/ingestion-worker.js). */
  scriptPath: string;
  /** Injectable worker factory (defaults to a real worker_threads Worker). */
  createWorker?: (scriptPath: string) => WorkerLike;
}

/** A {@link SpawnIngestionWorker} that forks a fresh worker thread per job. */
export function createWorkerThreadsSpawner(
  options: WorkerThreadsSpawnerOptions,
): SpawnIngestionWorker {
  const createWorker = options.createWorker ?? ((path: string) => new Worker(path));
  return () => createWorkerThreadsHostHandle(createWorker(options.scriptPath));
}
