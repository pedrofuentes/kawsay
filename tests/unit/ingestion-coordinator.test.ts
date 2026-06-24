import { describe, expect, it } from 'vitest';
import { createIngestionCoordinator } from '../../electron/main/importers/ingestion/coordinator';
import type {
  HostToWorkerMessage,
  IngestionJobSpec,
  IngestionWorkerHandle,
  WorkerToHostMessage,
} from '../../electron/main/importers/ingestion/protocol';
import { importProgressEventSchema, type ImportProgressEvent } from '@shared/ipc/events';
import type { IngestionSummary } from '../../electron/main/importers/ingest';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function job(overrides: Partial<IngestionJobSpec> = {}): IngestionJobSpec {
  return {
    jobId: UUID,
    sourceType: 'folder',
    inputPath: '/memories/photos',
    libraryRoot: '/lib',
    catalogPath: '/lib/catalog.sqlite3',
    sourceId: 'src-1',
    workDir: '/lib/extract/src-1',
    ...overrides,
  };
}

const summary: IngestionSummary = {
  recordCount: 2,
  itemsTouched: 2,
  occurrencesAdded: 2,
  assetsAdded: 1,
  thumbnailFailures: 0,
  skipped: [],
  cancelled: false,
};

/** A programmable worker double: the test pushes worker→host events via emit(). */
function fakeHandle() {
  let onMsg: ((m: WorkerToHostMessage) => void) | undefined;
  const posted: HostToWorkerMessage[] = [];
  let terminations = 0;
  const handle: IngestionWorkerHandle = {
    post: (m) => posted.push(m),
    onMessage: (h) => {
      onMsg = h;
    },
    terminate: () => {
      terminations += 1;
    },
  };
  return {
    handle,
    posted,
    emit: (m: WorkerToHostMessage) => onMsg?.(m),
    get terminations() {
      return terminations;
    },
  };
}

describe('createIngestionCoordinator (AC-9 host orchestration)', () => {
  it('waits for the ready handshake before sending the job (no spawn race)', () => {
    const worker = fakeHandle();
    const coordinator = createIngestionCoordinator({ spawn: () => worker.handle, emitProgress: () => {} });

    coordinator.start(job());
    expect(worker.posted).toEqual([]); // nothing sent until ready

    worker.emit({ type: 'ready' });
    expect(worker.posted).toEqual([{ type: 'start', job: job() }]);
    expect(coordinator.active()).toEqual([UUID]);
  });

  it('relays worker progress as a valid import:progress event', () => {
    const worker = fakeHandle();
    const events: ImportProgressEvent[] = [];
    const coordinator = createIngestionCoordinator({
      spawn: () => worker.handle,
      emitProgress: (e) => events.push(e),
    });

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    worker.emit({ type: 'progress', progress: { phase: 'emit', processed: 1, total: 2, message: 'one' } });

    expect(events).toHaveLength(1);
    expect(importProgressEventSchema.safeParse(events[0]).success).toBe(true);
    expect(events[0]).toMatchObject({ jobId: UUID, phase: 'emit', processed: 1, total: 2, message: 'one', summary: null, error: null });
  });

  it('emits a terminal done event and terminates the worker (teardown)', () => {
    const worker = fakeHandle();
    const events: ImportProgressEvent[] = [];
    const coordinator = createIngestionCoordinator({
      spawn: () => worker.handle,
      emitProgress: (e) => events.push(e),
    });

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    worker.emit({ type: 'done', summary });

    expect(events.at(-1)).toMatchObject({ jobId: UUID, phase: 'done', summary });
    expect(importProgressEventSchema.safeParse(events.at(-1)).success).toBe(true);
    expect(worker.terminations).toBe(1);
    expect(coordinator.active()).toEqual([]); // forgotten after teardown
  });

  it('maps a worker error onto a terminal error event and tears down', () => {
    const worker = fakeHandle();
    const events: ImportProgressEvent[] = [];
    const coordinator = createIngestionCoordinator({
      spawn: () => worker.handle,
      emitProgress: (e) => events.push(e),
    });

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    worker.emit({ type: 'error', message: 'unsupported source' });

    expect(events.at(-1)).toMatchObject({ jobId: UUID, phase: 'done', summary: null, error: 'unsupported source' });
    expect(importProgressEventSchema.safeParse(events.at(-1)).success).toBe(true);
    expect(worker.terminations).toBe(1);
    expect(coordinator.active()).toEqual([]);
  });

  it('forwards a cooperative cancel to the running worker', () => {
    const worker = fakeHandle();
    const coordinator = createIngestionCoordinator({ spawn: () => worker.handle, emitProgress: () => {} });

    coordinator.start(job());
    worker.emit({ type: 'ready' });

    expect(coordinator.cancel(UUID)).toBe(true);
    expect(worker.posted.at(-1)).toEqual({ type: 'cancel' });
    // The worker is torn down by the resulting partial `done`, not by cancel itself.
    expect(worker.terminations).toBe(0);

    worker.emit({ type: 'done', summary: { ...summary, recordCount: 1, cancelled: true } });
    expect(worker.terminations).toBe(1);
    expect(coordinator.active()).toEqual([]);
  });

  it('returns false when cancelling an unknown / already-finished job', () => {
    const worker = fakeHandle();
    const coordinator = createIngestionCoordinator({ spawn: () => worker.handle, emitProgress: () => {} });
    expect(coordinator.cancel('00000000-0000-0000-0000-000000000000')).toBe(false);

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    worker.emit({ type: 'done', summary });
    expect(coordinator.cancel(UUID)).toBe(false); // already finished
  });

  it('disposeAll terminates every in-flight worker (window-close teardown)', () => {
    const workers = [fakeHandle(), fakeHandle()];
    let i = 0;
    const coordinator = createIngestionCoordinator({ spawn: () => workers[i++].handle, emitProgress: () => {} });

    coordinator.start(job({ jobId: '11111111-1111-1111-1111-111111111111' }));
    coordinator.start(job({ jobId: '22222222-2222-2222-2222-222222222222' }));
    expect(coordinator.active()).toHaveLength(2);

    coordinator.disposeAll();
    expect(workers[0].terminations).toBe(1);
    expect(workers[1].terminations).toBe(1);
    expect(coordinator.active()).toEqual([]);
  });
});
