import { afterEach, describe, expect, it, vi } from 'vitest';
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
    ffmpegPath: '/bin/ffmpeg',
    ffprobePath: '/bin/ffprobe',
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

/** A programmable worker double: the test pushes worker→host events via emit(),
 *  and a worker_threads-level fault via emitError()/emitExit(). */
function fakeHandle() {
  let onMsg: ((m: WorkerToHostMessage) => void) | undefined;
  let onErr: ((error: Error) => void) | undefined;
  let onExit: ((code: number) => void) | undefined;
  const posted: HostToWorkerMessage[] = [];
  let terminations = 0;
  const handle: IngestionWorkerHandle = {
    post: (m) => posted.push(m),
    onMessage: (h) => {
      onMsg = h;
    },
    onError: (h) => {
      onErr = h;
    },
    onExit: (h) => {
      onExit = h;
    },
    terminate: () => {
      terminations += 1;
    },
  };
  return {
    handle,
    posted,
    emit: (m: WorkerToHostMessage) => onMsg?.(m),
    emitError: (error: Error) => onErr?.(error),
    emitExit: (code: number) => onExit?.(code),
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
      logWorkerFault: () => {},
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
      logWorkerFault: () => {},
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
      logWorkerFault: () => {},
    });

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    worker.emit({ type: 'error', message: 'unsupported source' });

    expect(events.at(-1)).toMatchObject({
      jobId: UUID,
      phase: 'done',
      summary: null,
      error: 'ingestion worker crashed before completing',
    });
    expect(importProgressEventSchema.safeParse(events.at(-1)).success).toBe(true);
    expect(worker.terminations).toBe(1);
    expect(coordinator.active()).toEqual([]);
  });

  it('NEVER forwards a raw worker error message to the renderer; only to the local logger (#440)', () => {
    const worker = fakeHandle();
    const events: ImportProgressEvent[] = [];
    const faultLog: Error[] = [];
    const coordinator = createIngestionCoordinator({
      spawn: () => worker.handle,
      emitProgress: (e) => events.push(e),
      logWorkerFault: (error) => faultLog.push(error),
    });

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    // A worker `error` protocol message whose text embeds a filesystem path + a
    // "secret" filename — the kind of raw detail that must NOT reach the renderer.
    const raw = 'parse failed at /Users/alice/private/secret.json';
    worker.emit({ type: 'error', message: raw });

    // The renderer-facing event carries ONLY the safe fixed copy — no path, no
    // filename, no parse detail (the sibling worker-fault path already does this).
    const terminal = events.at(-1);
    expect(terminal?.error).toBe('ingestion worker crashed before completing');
    expect(terminal?.error).not.toContain('/Users/alice');
    expect(terminal?.error).not.toContain('secret.json');
    expect(importProgressEventSchema.safeParse(terminal).success).toBe(true);

    // ...but the RAW message DID reach the local diagnostic sink (never the boundary).
    expect(faultLog).toHaveLength(1);
    expect(faultLog[0]?.message).toContain('/Users/alice/private/secret.json');

    expect(worker.terminations).toBe(1);
    expect(coordinator.active()).toEqual([]);
  });

  // #480 — the DEFAULT worker-fault sink (used when no `logWorkerFault` is injected)
  // must route the Error through the REDACTING logger, not `console.error(error.stack)`.
  // A raw stack/message can embed a filesystem path / item text; even the local console
  // must only ever see the projected {name, code} shape (AC "no PII to logs").
  describe('default logWorkerFault sink redacts through the logger (#480)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('never writes a raw worker stack/message to the local console', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const worker = fakeHandle();
      // No `logWorkerFault` injected → the coordinator's DEFAULT sink is exercised.
      const coordinator = createIngestionCoordinator({
        spawn: () => worker.handle,
        emitProgress: () => {},
      });

      coordinator.start(job());
      worker.emit({ type: 'ready' });
      worker.emitError(new Error('native crash at /Users/alice/private/secret.json'));

      expect(consoleError).toHaveBeenCalled();
      const serialized = JSON.stringify(consoleError.mock.calls);
      // The raw stack/message must never reach the console — only the projected shape.
      expect(serialized).not.toContain('/Users/alice');
      expect(serialized).not.toContain('secret.json');
      expect(serialized).not.toContain('native crash');
      // The projected {name} is what the redacting logger emits.
      expect(consoleError.mock.calls.some((call) => call.some((arg) =>
        arg !== null && typeof arg === 'object' && (arg as { name?: unknown }).name === 'IngestionWorkerFaultError',
      ))).toBe(true);
    });
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

  // Regression — Sentinel 🔴 (report sentinel-pr66-a0c06ac-f3c, finding #1): a worker
  // that faults OUTSIDE its job try/catch (module-load failure, native crash in
  // better-sqlite3/exifr/ffmpeg, OOM, process.exit) emits a worker_threads
  // `error`/`exit` EVENT, not a protocol `error`/`done` MESSAGE. The coordinator
  // must observe those events and settle the import (terminal error + teardown),
  // or the import hangs forever and the worker handle leaks.
  it('settles the import with a terminal error and tears down when the worker emits an error event', () => {
    const worker = fakeHandle();
    const events: ImportProgressEvent[] = [];
    const faultLog: Error[] = [];
    const coordinator = createIngestionCoordinator({
      spawn: () => worker.handle,
      emitProgress: (e) => events.push(e),
      logWorkerFault: (error) => faultLog.push(error),
    });

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    // The worker faults before it can post a terminal `done`/`error` message.
    worker.emitError(new Error('native crash in better-sqlite3'));

    const terminal = events.at(-1);
    expect(terminal).toMatchObject({ jobId: UUID, phase: 'done', summary: null });
    expect(terminal?.error).toBe('ingestion worker crashed before completing');
    expect(terminal?.error).not.toContain('better-sqlite3');
    expect(terminal?.error).not.toBeNull();
    expect(faultLog).toHaveLength(1);
    expect(faultLog[0]?.message).toContain('native crash in better-sqlite3');
    expect(faultLog[0]?.stack).toContain('Error: native crash in better-sqlite3');
    expect(importProgressEventSchema.safeParse(terminal).success).toBe(true);
    expect(worker.terminations).toBe(1); // handle torn down — no orphan
    expect(coordinator.active()).toEqual([]);
  });

  it('settles the import with a terminal error and tears down when the worker exits abnormally mid-import', () => {
    const worker = fakeHandle();
    const events: ImportProgressEvent[] = [];
    const coordinator = createIngestionCoordinator({
      spawn: () => worker.handle,
      emitProgress: (e) => events.push(e),
      logWorkerFault: () => {},
    });

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    worker.emit({ type: 'progress', progress: { phase: 'emit', processed: 1, total: 5, message: null } });
    // An abnormal exit (OOM kill / process.exit) with no terminal message.
    worker.emitExit(1);

    const terminal = events.at(-1);
    expect(terminal).toMatchObject({ jobId: UUID, phase: 'done', summary: null });
    expect(terminal?.error).not.toBeNull();
    expect(importProgressEventSchema.safeParse(terminal).success).toBe(true);
    expect(worker.terminations).toBe(1);
    expect(coordinator.active()).toEqual([]);
  });

  it('does NOT mis-report the exit that follows a graceful done as a failure', () => {
    const worker = fakeHandle();
    const events: ImportProgressEvent[] = [];
    const coordinator = createIngestionCoordinator({
      spawn: () => worker.handle,
      emitProgress: (e) => events.push(e),
    });

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    worker.emit({ type: 'done', summary });
    // terminate() on a live worker makes Node emit `exit` (with a non-zero code)
    // AFTER the graceful done — it must not be turned into a spurious error event.
    worker.emitExit(1);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ jobId: UUID, phase: 'done', summary, error: null });
    expect(worker.terminations).toBe(1); // exactly one teardown, from the done
    expect(coordinator.active()).toEqual([]);
  });

  it('emits exactly one terminal error when a worker both errors and exits', () => {
    const worker = fakeHandle();
    const events: ImportProgressEvent[] = [];
    const coordinator = createIngestionCoordinator({
      spawn: () => worker.handle,
      emitProgress: (e) => events.push(e),
      logWorkerFault: () => {},
    });

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    worker.emitError(new Error('boom'));
    worker.emitExit(1); // the exit that follows the crash must not double-report

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ jobId: UUID, phase: 'done', summary: null });
    expect(events[0]?.error).not.toBeNull();
    expect(worker.terminations).toBe(1);
    expect(coordinator.active()).toEqual([]);
  });
});
