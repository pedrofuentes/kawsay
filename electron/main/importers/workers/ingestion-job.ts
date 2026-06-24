// The WORKER-side driver (AC-9): the small amount of logic that runs inside the
// off-thread worker. It waits for a `start`, opens the heavy collaborators (db,
// repo, importer, deps, thumbnailer) via an injected `openContext`, drives the
// real `runIngestion` engine under an AbortController, streams its throttled
// progress back as `progress` messages, and finishes with `done` (carrying the
// summary, including a cooperative-cancel) or `error`. The context is ALWAYS
// closed afterwards (teardown), and a `cancel` simply aborts the signal so the
// engine stops at the next record and returns a partial summary — never a throw.
//
// `openContext` and `runIngestion` are injected so this is unit-testable with a
// fake port + an in-memory catalog + the REAL engine, no thread required.

import type { CatalogDatabase } from '../../db/connection';
import type { CatalogRepo } from '../../db/catalog-repo';
import { runIngestion as defaultRunIngestion, type ThumbnailGenerator } from '../ingest';
import type { Importer, ImporterDeps } from '../types';
import type { IngestionJobSpec, WorkerPort } from '../ingestion/protocol';

/** The heavy, per-job collaborators the worker assembles on its side of the
 *  boundary. `close` releases them (db handle, etc.) when the run ends. */
export interface IngestionContext {
  importer: Importer;
  db: CatalogDatabase;
  repo: CatalogRepo;
  deps: ImporterDeps;
  generateThumbnail: ThumbnailGenerator;
  close(): void;
}

export interface IngestionJobOptions {
  port: WorkerPort;
  /** Assembles the per-job context from the spec (opens catalog, picks importer). */
  openContext: (job: IngestionJobSpec) => IngestionContext | Promise<IngestionContext>;
  /** Injectable engine (defaults to the real runIngestion) for testing. */
  runIngestion?: typeof defaultRunIngestion;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wire the worker side onto a {@link WorkerPort}: install the command listener,
 * announce `ready`, and from then on run exactly one job, honouring cancel.
 */
export function startIngestionJob(options: IngestionJobOptions): void {
  const { port, openContext } = options;
  const runIngestion = options.runIngestion ?? defaultRunIngestion;
  const controller = new AbortController();
  let started = false;

  port.onMessage((message) => {
    if (message.type === 'cancel') {
      // Cooperative stop: the engine checks this between records (AC-9/AC-15).
      controller.abort();
      return;
    }
    if (message.type === 'start') {
      if (started) return; // one job per worker
      started = true;
      void runJob(message.job);
    }
  });

  async function runJob(job: IngestionJobSpec): Promise<void> {
    let context: IngestionContext | undefined;
    try {
      context = await openContext(job);
      const summary = await runIngestion({
        importer: context.importer,
        inputPath: job.inputPath,
        db: context.db,
        repo: context.repo,
        libraryRoot: job.libraryRoot,
        sourceId: job.sourceId,
        workDir: job.workDir,
        deps: context.deps,
        generateThumbnail: context.generateThumbnail,
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

  // Announce readiness only AFTER the listener is installed, so the host's
  // `start` can never arrive before we're listening.
  port.post({ type: 'ready' });
}
