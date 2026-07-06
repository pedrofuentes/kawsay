// The off-thread categorization CLUSTER worker ENTRY (#344 / ADR-0030 Decision 6).
// electron-vite builds this as a fourth main-process output (out/main/categorization-
// cluster-worker.js); the host runs each cluster request on a fresh worker_threads
// worker (see createWorkerThreadClusterTransport) and terminates it afterward. It
// binds the shared worker-side handler onto the real parentPort so the two CPU-bound
// cluster passes (haversine DBSCAN places + cosine agglomeration themes) run here,
// never on the UI thread. Pure compute over the message payload — no better-sqlite3 /
// native deps — so no asarUnpack is needed. Mirrors the ingestion + transcription
// worker entries.

import { parentPort } from 'node:worker_threads';
import { bindClusterWorker } from '../categorization-worker';
import type { MessagePortLike } from '../../transcription/queue/worker-threads-transport';

export interface CategorizationClusterWorkerEntryOptions {
  parentPort: MessagePortLike | null;
}

export function bindCategorizationClusterWorkerEntry(
  options: CategorizationClusterWorkerEntryOptions,
): void {
  if (options.parentPort === null) {
    throw new Error('categorization-cluster-worker must be run as a worker thread');
  }
  bindClusterWorker(options.parentPort);
}

if (parentPort !== null) {
  bindCategorizationClusterWorkerEntry({ parentPort });
}
