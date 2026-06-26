// The WORKER-side driver (AC-18): the small amount of logic that runs inside the
// off-thread transcription worker. It waits for a `start`, assembles the heavy
// collaborators (the audio extractor + the whisper-cli executor) via an injected
// `openContext`, drives the real `runTranscriptionBatch` engine under an
// AbortController, streams its progress back as `progress` messages, and finishes
// with `done` (carrying the summary, including a cooperative-cancel) or `error`. The
// context is ALWAYS closed afterwards (teardown), and a `cancel` simply aborts the
// signal so the engine forwards the kill to the in-flight whisper-cli child and stops
// dispatching the rest — never a throw. Mirrors the F3c ingestion job driver.
//
// `openContext` and `runBatch` are injected so this is unit-testable with a fake port
// + a fake executor + the REAL batch engine, no thread required.

import {
  runTranscriptionBatch as defaultRunBatch,
} from '../transcribe-batch';
import type { Transcriber } from '../transcribe';
import type { TranscriptionJobSpec, WorkerPort } from '../queue/protocol';

/** The per-batch collaborators the worker assembles on its side of the boundary.
 *  `close` releases any resources when the run ends. */
export interface TranscriptionContext {
  transcribe: Transcriber;
  close(): void;
}

export interface TranscriptionJobOptions {
  port: WorkerPort;
  /** Assembles the per-batch context from the spec (resolves extractor + executor). */
  openContext: (job: TranscriptionJobSpec) => TranscriptionContext | Promise<TranscriptionContext>;
  /** Injectable engine (defaults to the real runTranscriptionBatch) for testing. */
  runBatch?: typeof defaultRunBatch;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wire the worker side onto a {@link WorkerPort}: install the command listener,
 * announce `ready`, and from then on run exactly one batch, honouring cancel.
 */
export function startTranscriptionJob(options: TranscriptionJobOptions): void {
  const { port, openContext } = options;
  const runBatch = options.runBatch ?? defaultRunBatch;
  const controller = new AbortController();
  let started = false;

  port.onMessage((message) => {
    if (message.type === 'cancel') {
      // Cooperative stop: the executor forwards this to the in-flight whisper-cli
      // child (SIGKILL) and the batch stops dispatching the rest (AC-20).
      controller.abort();
      return;
    }
    if (message.type === 'start') {
      if (started) return; // one batch per worker
      started = true;
      void runJob(message.job);
    }
  });

  async function runJob(job: TranscriptionJobSpec): Promise<void> {
    let context: TranscriptionContext | undefined;
    try {
      context = await openContext(job);
      const summary = await runBatch({
        transcribe: context.transcribe,
        items: job.items,
        signal: controller.signal,
        onProgress: (progress) => port.post({ type: 'progress', progress }),
      });
      port.post({ type: 'done', summary });
    } catch (error) {
      port.post({ type: 'error', message: errorMessage(error) });
    } finally {
      context?.close();
    }
  }

  // Announce readiness only AFTER the listener is installed, so the host's `start`
  // can never arrive before we're listening.
  port.post({ type: 'ready' });
}
