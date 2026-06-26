// A real worker_threads stand-in for the transcription worker, used by
// transcription-thread.test.ts to prove the host handle + coordinator drive a
// GENUINE OS thread end-to-end (AC-18): handshake, streamed per-item progress,
// cooperative cancel (stop dispatching + mark the rest cancelled), and clean
// teardown (the thread exits once the host terminates it).
//
// It speaks the exact host↔worker protocol in plain JS (no TS imports, like the
// AC-4 harnesses) — the worker-side ENGINE logic is covered separately by
// transcription-job.test.ts against the real runTranscriptionBatch.
import { parentPort } from 'node:worker_threads';

const STEP_MS = 20;
let cancelled = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

parentPort.on('message', async (message) => {
  if (message.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (message.type !== 'start') return;

  const items = message.job.items;
  const total = items.length;
  const outcomes = [];

  for (let index = 0; index < total; index += 1) {
    const item = items[index];
    parentPort.postMessage({
      type: 'progress',
      progress: { phase: 'item-start', index, total, id: item.id },
    });

    let outcome;
    if (cancelled) {
      // A fired cancel stops dispatch: the remaining items are reported, never run.
      outcome = { id: item.id, status: 'cancelled', transcript: null };
    } else {
      await sleep(STEP_MS); // simulate the off-thread whisper-cli run
      outcome = {
        id: item.id,
        status: 'transcribed',
        transcript: { text: `text-${item.id}`, language: 'es', segments: [] },
      };
    }
    outcomes.push(outcome);
    parentPort.postMessage({
      type: 'progress',
      progress: { phase: 'item-done', index, total, id: item.id, outcome },
    });
  }

  const transcribed = outcomes.filter((o) => o.status === 'transcribed').length;
  const cancelledCount = outcomes.filter((o) => o.status === 'cancelled').length;
  const skipped = total - transcribed - cancelledCount;

  parentPort.postMessage({
    type: 'progress',
    progress: { phase: 'batch-done', total, transcribed, skipped, cancelled: cancelledCount },
  });
  parentPort.postMessage({
    type: 'done',
    summary: { total, transcribed, skipped, cancelled: cancelledCount, outcomes },
  });
});

// Announce readiness only after the listener is installed (mirrors the real
// worker), so the host's `start` can never race the spawn.
parentPort.postMessage({ type: 'ready' });
