import { describe, expect, it } from 'vitest';
import {
  createTranscriptionCoordinator,
  type TranscriptionCoordinatorEvent,
} from '../../electron/main/transcription/queue/coordinator';
import type {
  HostToWorkerMessage,
  TranscriptionJobSpec,
  TranscriptionWorkerHandle,
  WorkerToHostMessage,
} from '../../electron/main/transcription/queue/protocol';
import type { TranscriptionBatchSummary } from '../../electron/main/transcription/transcribe-batch';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function job(overrides: Partial<TranscriptionJobSpec> = {}): TranscriptionJobSpec {
  return {
    jobId: UUID,
    items: [
      { id: 'a', sourcePath: '/src/a.opus' },
      { id: 'b', sourcePath: '/src/b.opus' },
    ],
    modelPath: '/models/ggml-small.bin',
    whisperCliPath: '/bin/whisper-cli',
    scratchDir: '/scratch',
    ...overrides,
  };
}

const summary: TranscriptionBatchSummary = {
  total: 2,
  transcribed: 2,
  skipped: 0,
  cancelled: 0,
  outcomes: [
    { id: 'a', status: 'transcribed', transcript: { text: 'a', language: 'es', segments: [] } },
    { id: 'b', status: 'transcribed', transcript: { text: 'b', language: 'es', segments: [] } },
  ],
};

/** A programmable worker double: push worker→host events via emit(), and a
 *  worker_threads-level fault via emitError()/emitExit(). */
function fakeHandle() {
  let onMsg: ((m: WorkerToHostMessage) => void) | undefined;
  let onErr: ((error: Error) => void) | undefined;
  let onExit: ((code: number) => void) | undefined;
  const posted: HostToWorkerMessage[] = [];
  let terminations = 0;
  const handle: TranscriptionWorkerHandle = {
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

describe('createTranscriptionCoordinator (off-thread host orchestration — AC-18/AC-20)', () => {
  it('waits for the ready handshake before sending the job (no spawn race)', () => {
    const worker = fakeHandle();
    const coordinator = createTranscriptionCoordinator({ spawn: () => worker.handle, emit: () => {} });

    coordinator.start(job());
    expect(worker.posted).toEqual([]); // nothing sent until ready

    worker.emit({ type: 'ready' });
    expect(worker.posted).toEqual([{ type: 'start', job: job() }]);
    expect(coordinator.active()).toEqual([UUID]);
  });

  it('relays worker progress as a typed coordinator progress event', () => {
    const worker = fakeHandle();
    const events: TranscriptionCoordinatorEvent[] = [];
    const coordinator = createTranscriptionCoordinator({
      spawn: () => worker.handle,
      emit: (e) => events.push(e),
    });

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    worker.emit({
      type: 'progress',
      progress: { phase: 'item-start', index: 0, total: 2, id: 'a' },
    });

    expect(events).toEqual([
      { jobId: UUID, kind: 'progress', progress: { phase: 'item-start', index: 0, total: 2, id: 'a' } },
    ]);
  });

  it('emits a terminal done event carrying the summary and terminates the worker (teardown)', () => {
    const worker = fakeHandle();
    const events: TranscriptionCoordinatorEvent[] = [];
    const coordinator = createTranscriptionCoordinator({
      spawn: () => worker.handle,
      emit: (e) => events.push(e),
    });

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    worker.emit({ type: 'done', summary });

    expect(events.at(-1)).toEqual({ jobId: UUID, kind: 'done', summary });
    expect(worker.terminations).toBe(1);
    expect(coordinator.active()).toEqual([]); // forgotten after teardown
  });

  it('maps a worker error message onto a terminal error event and tears down', () => {
    const worker = fakeHandle();
    const events: TranscriptionCoordinatorEvent[] = [];
    const coordinator = createTranscriptionCoordinator({
      spawn: () => worker.handle,
      emit: (e) => events.push(e),
    });

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    worker.emit({ type: 'error', message: 'model unavailable' });

    expect(events.at(-1)).toEqual({ jobId: UUID, kind: 'error', message: 'model unavailable' });
    expect(worker.terminations).toBe(1);
    expect(coordinator.active()).toEqual([]);
  });

  it('forwards a cooperative cancel to the running worker (cancel kills the in-flight child)', () => {
    const worker = fakeHandle();
    const coordinator = createTranscriptionCoordinator({ spawn: () => worker.handle, emit: () => {} });

    coordinator.start(job());
    worker.emit({ type: 'ready' });

    expect(coordinator.cancel(UUID)).toBe(true);
    expect(worker.posted.at(-1)).toEqual({ type: 'cancel' });
    // The worker is torn down by the resulting cancelled `done`, not by cancel itself.
    expect(worker.terminations).toBe(0);

    worker.emit({ type: 'done', summary: { ...summary, transcribed: 0, cancelled: 2 } });
    expect(worker.terminations).toBe(1);
    expect(coordinator.active()).toEqual([]);
  });

  it('returns false when cancelling an unknown / already-finished job', () => {
    const worker = fakeHandle();
    const coordinator = createTranscriptionCoordinator({ spawn: () => worker.handle, emit: () => {} });
    expect(coordinator.cancel('00000000-0000-0000-0000-000000000000')).toBe(false);

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    worker.emit({ type: 'done', summary });
    expect(coordinator.cancel(UUID)).toBe(false); // already finished
  });

  it('disposeAll terminates every in-flight worker (window-close teardown)', () => {
    const workers = [fakeHandle(), fakeHandle()];
    let i = 0;
    const coordinator = createTranscriptionCoordinator({
      spawn: () => workers[i++].handle,
      emit: () => {},
    });

    coordinator.start(job({ jobId: '11111111-1111-1111-1111-111111111111' }));
    coordinator.start(job({ jobId: '22222222-2222-2222-2222-222222222222' }));
    expect(coordinator.active()).toHaveLength(2);

    coordinator.disposeAll();
    expect(workers[0].terminations).toBe(1);
    expect(workers[1].terminations).toBe(1);
    expect(coordinator.active()).toEqual([]);
  });

  it('settles the batch with a terminal error and tears down when the worker emits an error event', () => {
    const worker = fakeHandle();
    const events: TranscriptionCoordinatorEvent[] = [];
    const coordinator = createTranscriptionCoordinator({
      spawn: () => worker.handle,
      emit: (e) => events.push(e),
    });

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    // A fault before any terminal message (native crash in whisper-cli glue, OOM).
    worker.emitError(new Error('native crash'));

    const terminal = events.at(-1);
    expect(terminal?.kind).toBe('error');
    if (terminal?.kind === 'error') expect(terminal.message).toContain('native crash');
    expect(worker.terminations).toBe(1); // handle torn down — no orphan
    expect(coordinator.active()).toEqual([]);
  });

  it('settles the batch with a terminal error and tears down when the worker exits abnormally mid-run', () => {
    const worker = fakeHandle();
    const events: TranscriptionCoordinatorEvent[] = [];
    const coordinator = createTranscriptionCoordinator({
      spawn: () => worker.handle,
      emit: (e) => events.push(e),
    });

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    worker.emit({ type: 'progress', progress: { phase: 'item-start', index: 0, total: 2, id: 'a' } });
    worker.emitExit(1); // abnormal exit, no terminal message

    const terminal = events.at(-1);
    expect(terminal?.kind).toBe('error');
    expect(worker.terminations).toBe(1);
    expect(coordinator.active()).toEqual([]);
  });

  it('does NOT mis-report the exit that follows a graceful done as a failure', () => {
    const worker = fakeHandle();
    const events: TranscriptionCoordinatorEvent[] = [];
    const coordinator = createTranscriptionCoordinator({
      spawn: () => worker.handle,
      emit: (e) => events.push(e),
    });

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    worker.emit({ type: 'done', summary });
    worker.emitExit(1); // the exit terminate() causes, AFTER the graceful done

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ jobId: UUID, kind: 'done', summary });
    expect(worker.terminations).toBe(1); // exactly one teardown, from the done
    expect(coordinator.active()).toEqual([]);
  });

  it('emits exactly one terminal error when a worker both errors and exits', () => {
    const worker = fakeHandle();
    const events: TranscriptionCoordinatorEvent[] = [];
    const coordinator = createTranscriptionCoordinator({
      spawn: () => worker.handle,
      emit: (e) => events.push(e),
    });

    coordinator.start(job());
    worker.emit({ type: 'ready' });
    worker.emitError(new Error('boom'));
    worker.emitExit(1); // the exit that follows the crash must not double-report

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
    expect(worker.terminations).toBe(1);
    expect(coordinator.active()).toEqual([]);
  });
});
