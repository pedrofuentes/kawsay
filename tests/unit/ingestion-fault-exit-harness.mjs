// A real worker_threads stand-in that EXITS ABNORMALLY mid-import: it completes
// the handshake, streams one progress tick, then calls process.exit(1) WITHOUT
// posting a terminal `done`/`error` message (mirrors an OOM kill, a native
// abort, or a rogue process.exit). Node emits an `exit` EVENT with a non-zero
// code; the coordinator must settle the import on it (terminal error + teardown)
// or the import hangs forever and the worker handle leaks. Used by
// ingestion-thread-fault.test.ts.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (message) => {
  if (message.type !== 'start') return;
  parentPort.postMessage({
    type: 'progress',
    progress: { phase: 'emit', processed: 0, total: 3, message: null },
  });
  // Die abnormally before the terminal `done` — no graceful teardown handshake.
  setTimeout(() => process.exit(1), 10);
});

// Announce readiness after the listener is installed (mirrors the real worker).
parentPort.postMessage({ type: 'ready' });
