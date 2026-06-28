import { afterEach, describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createIngestionCoordinator } from '../../electron/main/importers/ingestion/coordinator';
import { createWorkerThreadsHostHandle } from '../../electron/main/importers/ingestion/worker-threads-transport';
import type { IngestionJobSpec } from '../../electron/main/importers/ingestion/protocol';
import { importProgressEventSchema, type ImportProgressEvent } from '@shared/ipc/events';

// Regression — Sentinel 🔴 (report sentinel-pr66-a0c06ac-f3c, finding #1). These
// drive a GENUINE OS worker thread that faults the way an untrusted-file parse
// can (a module-load throw, or an abnormal mid-import exit) and prove the host
// CONTAINS it: the Electron main process never crashes (no uncaughtException
// escapes), the import settles with a terminal error, and the worker is torn
// down (no orphan). On the pre-fix code the worker `error` propagates to the
// parent (process crash) and the abnormal `exit` orphans the handle forever.

const THROW_HARNESS = fileURLToPath(new URL('./ingestion-fault-throw-harness.mjs', import.meta.url));
const EXIT_HARNESS = fileURLToPath(new URL('./ingestion-fault-exit-harness.mjs', import.meta.url));
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

/** Run a faulting worker harness on a real thread and resolve once a terminal
 *  (`phase: 'done'`) event arrives — or reject if none does within `ms`. */
function runFaultingWorker(harness: string, ms = 5000) {
  const events: ImportProgressEvent[] = [];
  const coordinator = createIngestionCoordinator({
    spawn: () => createWorkerThreadsHostHandle(new Worker(harness)),
    emitProgress: (event) => events.push(event),
  });

  const settled = new Promise<ImportProgressEvent>((resolve, reject) => {
    const deadline = Date.now() + ms;
    const timer = setInterval(() => {
      const terminal = events.find((e) => e.phase === 'done');
      if (terminal !== undefined) {
        clearInterval(timer);
        resolve(terminal);
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('import never settled — the worker fault orphaned the handle'));
      }
    }, 5);
  });

  coordinator.start(job());
  return { coordinator, events, settled };
}

// Capture any worker fault that escapes to the process so the assertion can prove
// the main process was NOT crashed (and so a RED run never tears down the suite).
const escaped: unknown[] = [];
const onUncaught = (error: unknown): void => {
  escaped.push(error);
};
afterEach(() => {
  process.off('uncaughtException', onUncaught);
  escaped.length = 0;
});

describe('worker faults are contained on a real thread (AC-9 fault isolation)', () => {
  it('a worker that throws at load does not crash the main process and settles the import with an error', async () => {
    process.on('uncaughtException', onUncaught);
    const { coordinator, settled } = runFaultingWorker(THROW_HARNESS);

    const terminal = await settled;

    expect(escaped).toEqual([]); // no uncaughtException reached the host
    expect(terminal).toMatchObject({ jobId: JOB_ID, phase: 'done', summary: null });
    expect(terminal.error).not.toBeNull();
    expect(importProgressEventSchema.safeParse(terminal).success).toBe(true);
    expect(coordinator.active()).toEqual([]); // handle torn down — no orphan
  }, 15000);

  it('a worker that exits abnormally mid-import does not orphan the handle and settles with an error', async () => {
    process.on('uncaughtException', onUncaught);
    const { coordinator, events, settled } = runFaultingWorker(EXIT_HARNESS);

    const terminal = await settled;

    expect(escaped).toEqual([]);
    expect(terminal).toMatchObject({ jobId: JOB_ID, phase: 'done', summary: null });
    expect(terminal.error).not.toBeNull();
    expect(coordinator.active()).toEqual([]);
    // The progress streamed before the crash is still a valid event.
    for (const event of events) {
      expect(importProgressEventSchema.safeParse(event).success).toBe(true);
    }
  }, 15000);
});
