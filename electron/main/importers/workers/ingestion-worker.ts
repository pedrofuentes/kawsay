// The off-thread ingestion worker ENTRY (AC-9). electron-vite builds this as a
// second main-process output (out/main/ingestion-worker.js); the host forks it
// with worker_threads (see createWorkerThreadsSpawner). It binds the worker port
// onto the real parentPort and starts the job driver with the concrete context
// opener — so heavy parsing/hashing/ffprobe runs here, never on the UI thread.

import { parentPort } from 'node:worker_threads';
import { createParentPortWorkerPort } from '../ingestion/worker-threads-transport';
import { startIngestionJob } from './ingestion-job';
import { openIngestionContext } from './ingestion-context';
import type { MessagePortLike } from '../ingestion/worker-threads-transport';

export interface IngestionWorkerEntryOptions {
  parentPort: MessagePortLike | null;
}

export function bindIngestionWorkerEntry(options: IngestionWorkerEntryOptions): void {
  if (options.parentPort === null) {
    throw new Error('ingestion-worker must be run as a worker thread');
  }

  startIngestionJob({
    port: createParentPortWorkerPort(options.parentPort),
    openContext: openIngestionContext,
  });
}

if (parentPort !== null) {
  bindIngestionWorkerEntry({ parentPort });
}
