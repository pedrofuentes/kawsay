import { describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { bindIngestionWorkerEntry } from '../../electron/main/importers/workers/ingestion-worker';
import { createIngestionCoordinator } from '../../electron/main/importers/ingestion/coordinator';
import { createWorkerThreadsHostHandle } from '../../electron/main/importers/ingestion/worker-threads-transport';
import type { IngestionJobSpec } from '../../electron/main/importers/ingestion/protocol';
import { importProgressEventSchema, type ImportProgressEvent } from '@shared/ipc/events';

const HARNESS = fileURLToPath(new URL('./ingestion-thread-harness.mjs', import.meta.url));
const JOB_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function job(): IngestionJobSpec {
  return {
    jobId: JOB_ID,
    sourceType: 'folder',
    inputPath: '/memories',
    libraryRoot: '/lib',
    catalogPath: '/lib/catalog.sqlite3',
    sourceId: 'src-1',
    workDir: '/lib/extract/src-1',
    ffmpegPath: '/bin/ffmpeg',
    ffprobePath: '/bin/ffprobe',
  };
}

/** Run one real-thread import, returning the streamed events and a promise that
 *  resolves when the OS thread has actually exited (the teardown proof). */
function runOnRealThread(onFirstProgress?: (coordinator: ReturnType<typeof createIngestionCoordinator>) => void) {
  const worker = new Worker(HARNESS);
  const exited = new Promise<void>((resolve) => worker.on('exit', () => resolve()));
  const events: ImportProgressEvent[] = [];
  let sawFirstProgress = false;

  const coordinator = createIngestionCoordinator({
    spawn: () => createWorkerThreadsHostHandle(worker),
    emitProgress: (event) => {
      events.push(event);
      if (event.phase !== 'done' && !sawFirstProgress) {
        sawFirstProgress = true;
        onFirstProgress?.(coordinator);
      }
    },
  });

  const done = new Promise<ImportProgressEvent>((resolve) => {
    const timer = setInterval(() => {
      const terminal = events.find((e) => e.phase === 'done');
      if (terminal !== undefined) {
        clearInterval(timer);
        resolve(terminal);
      }
    }, 5);
  });

  coordinator.start(job());
  return { coordinator, events, done, exited };
}

describe('ingestion over a real worker_threads thread (AC-9 off-thread proof)', () => {
  it('binds the real worker entry to the concrete ingestion context opener', () => {
    const posts: unknown[] = [];
    const listeners: ((message: unknown) => void)[] = [];

    bindIngestionWorkerEntry({
      parentPort: {
        postMessage: (value) => posts.push(value),
        on: (_event, listener) => listeners.push(listener),
      },
    });

    expect(listeners).toHaveLength(1);
    expect(posts).toEqual([{ type: 'ready' }]);
  });

  it('streams progress off-thread and tears the thread down on completion', async () => {
    const { coordinator, events, done, exited } = runOnRealThread();

    const terminal = await done;
    await exited; // the OS thread genuinely exited — no orphaned worker

    const progress = events.filter((e) => e.phase !== 'done');
    expect(progress.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(importProgressEventSchema.safeParse(event).success).toBe(true);
      expect(event.jobId).toBe(JOB_ID);
    }
    expect(terminal.summary?.cancelled).toBe(false);
    expect(terminal.summary?.recordCount).toBe(5);
    expect(coordinator.active()).toEqual([]);
  }, 15000);

  it('cancels mid-stream on a real thread and stops gracefully (partial summary)', async () => {
    const { coordinator, done, exited } = runOnRealThread((c) => c.cancel(JOB_ID));

    const terminal = await done;
    await exited;

    expect(terminal.summary?.cancelled).toBe(true);
    expect(terminal.summary?.recordCount).toBeLessThan(5); // stopped early
    expect(coordinator.active()).toEqual([]);
  }, 15000);
});
