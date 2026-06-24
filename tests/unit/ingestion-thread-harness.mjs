// A real worker_threads stand-in for the ingestion worker, used by
// ingestion-thread.test.ts to prove the host handle + coordinator drive a
// GENUINE OS thread end-to-end (AC-9): handshake, streamed progress, cooperative
// cancel, and clean teardown (the thread exits once the host terminates it).
//
// It speaks the exact host↔worker protocol in plain JS (no TS imports, like the
// AC-4 harnesses) — the worker-side ENGINE logic is covered separately by
// ingestion-job.test.ts against the real runIngestion.
import { parentPort } from 'node:worker_threads';

const TOTAL = 5;
const STEP_MS = 20;
let cancelled = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

parentPort.on('message', async (message) => {
  if (message.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (message.type !== 'start') return;

  let produced = 0;
  for (let i = 0; i < TOTAL; i += 1) {
    if (cancelled) break;
    parentPort.postMessage({
      type: 'progress',
      progress: { phase: 'emit', processed: i, total: TOTAL, message: null },
    });
    produced = i + 1;
    await sleep(STEP_MS);
  }

  parentPort.postMessage({
    type: 'done',
    summary: {
      recordCount: produced,
      itemsTouched: produced,
      occurrencesAdded: produced,
      assetsAdded: 0,
      thumbnailFailures: 0,
      skipped: [],
      cancelled,
    },
  });
});

// Announce readiness only after the listener is installed (mirrors the real
// worker), so the host's `start` can never race the spawn.
parentPort.postMessage({ type: 'ready' });
