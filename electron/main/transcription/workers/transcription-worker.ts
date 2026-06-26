// The off-thread transcription worker ENTRY (AC-18). electron-vite builds this as a
// third main-process output (out/main/transcription-worker.js); the host forks it with
// worker_threads (see createWorkerThreadsSpawner). It binds the worker port onto the
// real parentPort and starts the batch driver with the concrete context opener — so the
// whisper-cli subprocess orchestration runs here, never on the UI thread. Mirrors the
// F3c ingestion worker entry.

import { parentPort } from 'node:worker_threads';
import { createParentPortWorkerPort } from '../queue/worker-threads-transport';
import { startTranscriptionJob } from './transcription-job';
import { openTranscriptionContext } from './transcription-context';

if (parentPort === null) {
  throw new Error('transcription-worker must be run as a worker thread');
}

startTranscriptionJob({
  port: createParentPortWorkerPort(parentPort),
  openContext: openTranscriptionContext,
});
