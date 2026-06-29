import { describe, expect, it, vi } from 'vitest';
import {
  createTranscriptionOrchestrator,
  type TranscriptionGate,
  type TranscriptionJobConfig,
  type TranscriptionLibraryItem,
  type TranscriptionLibraryPort,
  type TranscriptionOrchestratorOptions,
} from '../../electron/main/transcription/transcription-orchestrator';
import type { TranscriptionCoordinatorEvent } from '../../electron/main/transcription/queue/coordinator';
import type { TranscriptionJobSpec } from '../../electron/main/transcription/queue/protocol';
import type { TranscriptionItemOutcome } from '../../electron/main/transcription/transcribe-batch';
import type { Transcript } from '../../electron/main/transcription/transcribe';
import type { TranscriptionSnapshotDTO } from '@shared/ipc/schemas';

// Three distinct catalog ids (uuids — the renderer-facing snapshot validates them).
const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';
const ITEM_C = '33333333-3333-4333-8333-333333333333';
const JOB_ID = 'job-0001';
const ZERO_COUNTS = { total: 0, transcribed: 0, failed: 0, skipped: 0, inFlight: 0 };

function transcript(text = 'hello there'): Transcript {
  return { text, language: 'en', segments: [{ startMs: 0, endMs: 1200, text }] };
}

/** A library port double: a configurable item list + a `done` set, recording saves/statuses. */
function fakeLibrary(
  items: TranscriptionLibraryItem[],
  done: Set<string> = new Set(),
  over: Partial<TranscriptionLibraryPort> = {},
) {
  const saved: { itemId: string; text: string; language: string | null }[] = [];
  const statuses: { itemId: string; status: 'failed' | 'skipped' }[] = [];
  // An overriding saveTranscript (e.g. one that throws) runs FIRST, so a thrown
  // persistence is observed by the orchestrator; a successful save is then
  // recorded — so `saved` reflects exactly the items that persisted cleanly.
  const overSave = over.saveTranscript;
  const port: TranscriptionLibraryPort = {
    listItems: over.listItems ?? (() => items),
    isTranscribed: over.isTranscribed ?? ((id) => done.has(id)),
    saveTranscript: (input) => {
      overSave?.(input);
      saved.push({ itemId: input.itemId, text: input.text, language: input.language });
    },
    recordStatus:
      over.recordStatus ??
      ((id, status) => {
        statuses.push({ itemId: id, status });
      }),
  };
  return { port, saved, statuses };
}

function fakeWorker() {
  const started: TranscriptionJobSpec[] = [];
  const cancelled: string[] = [];
  return {
    started,
    cancelled,
    port: {
      start: (job: TranscriptionJobSpec) => {
        started.push(job);
      },
      cancel: (jobId: string) => {
        cancelled.push(jobId);
        return true;
      },
    },
  };
}

const JOB_CONFIG: TranscriptionJobConfig = {
  modelPath: '/models/ggml-small.bin',
  whisperCliPath: '/res/whisper-cli',
  ffmpegPath: '/res/ffmpeg',
  scratchDir: '/lib/extract/transcription',
};

function harness(opts: {
  items?: TranscriptionLibraryItem[];
  done?: Set<string>;
  optedIn?: boolean;
  modelReady?: boolean;
  library?: Partial<TranscriptionLibraryPort>;
  jobConfig?: TranscriptionJobConfig;
}) {
  const lib = fakeLibrary(opts.items ?? [], opts.done ?? new Set(), opts.library);
  const worker = fakeWorker();
  const emitted: TranscriptionSnapshotDTO[] = [];
  const gate: TranscriptionGate = {
    isOptedIn: vi.fn(() => opts.optedIn ?? true),
    isModelReady: vi.fn(() => Promise.resolve(opts.modelReady ?? true)),
  };
  const options: TranscriptionOrchestratorOptions = {
    gate,
    getLibrary: () => lib.port,
    worker: worker.port,
    resolveJobConfig: () => opts.jobConfig ?? JOB_CONFIG,
    emitProgress: (snapshot) => emitted.push(snapshot),
    newJobId: () => JOB_ID,
  };
  const orchestrator = createTranscriptionOrchestrator(options);
  return { orchestrator, lib, worker, emitted, gate };
}

function itemDone(id: string, outcome: TranscriptionItemOutcome): TranscriptionCoordinatorEvent {
  return {
    jobId: JOB_ID,
    kind: 'progress',
    progress: { phase: 'item-done', index: 0, total: 1, id, outcome },
  };
}

describe('transcription orchestrator — gating (AC-22, never auto-start)', () => {
  it('refuses to start when the user has NOT opted in (no worker dispatched)', async () => {
    const { orchestrator, worker } = harness({
      items: [{ id: ITEM_A, sourcePath: '/a.m4a', durationSec: 10 }],
      optedIn: false,
      modelReady: true,
    });

    const result = await orchestrator.start();

    expect(result.outcome).toBe('refused');
    expect(result.reason).toBe('not-opted-in');
    expect(worker.started).toHaveLength(0);
  });

  it('refuses to start when the model is not present+verified (no worker dispatched)', async () => {
    const { orchestrator, worker, gate } = harness({
      items: [{ id: ITEM_A, sourcePath: '/a.m4a', durationSec: 10 }],
      optedIn: true,
      modelReady: false,
    });

    const result = await orchestrator.start();

    expect(result.outcome).toBe('refused');
    expect(result.reason).toBe('model-not-ready');
    expect(gate.isModelReady).toHaveBeenCalledTimes(1);
    expect(worker.started).toHaveLength(0);
  });

  it('NEVER auto-starts: merely constructing the orchestrator dispatches nothing', () => {
    const { worker, gate } = harness({
      items: [{ id: ITEM_A, sourcePath: '/a.m4a', durationSec: 10 }],
    });

    expect(worker.started).toHaveLength(0);
    expect(gate.isModelReady).not.toHaveBeenCalled();
    expect(gate.isOptedIn).not.toHaveBeenCalled();
  });

  it('starts idle when opted-in + model-ready but the library has no audio/video items', async () => {
    const { orchestrator, worker } = harness({ items: [] });

    const result = await orchestrator.start();

    expect(result.outcome).toBe('idle');
    expect(result.counts.total).toBe(0);
    expect(worker.started).toHaveLength(0);
  });
});

describe('transcription orchestrator — enumerate + dispatch (AC-18)', () => {
  it('enumerates audio/video items and runs the batch off-thread with their resolved paths', async () => {
    const { orchestrator, worker } = harness({
      items: [
        { id: ITEM_A, sourcePath: '/a.m4a', durationSec: 10 },
        { id: ITEM_B, sourcePath: '/b.mp4', durationSec: 20 },
      ],
    });

    const result = await orchestrator.start();

    expect(result.outcome).toBe('started');
    expect(result.counts.total).toBe(2);
    expect(worker.started).toHaveLength(1);
    const job = worker.started[0];
    expect(job.items.map((i) => i.id)).toEqual([ITEM_A, ITEM_B]);
    expect(job.items.map((i) => i.sourcePath)).toEqual(['/a.m4a', '/b.mp4']);
    expect(job.modelPath).toBe(JOB_CONFIG.modelPath);
    expect(job.whisperCliPath).toBe(JOB_CONFIG.whisperCliPath);
    expect(orchestrator.status().state).toBe('running');
  });

  it('is idempotent: items already transcribed (skipWhen done) are NOT re-dispatched', async () => {
    const { orchestrator, worker } = harness({
      items: [
        { id: ITEM_A, sourcePath: '/a.m4a', durationSec: 10 },
        { id: ITEM_B, sourcePath: '/b.mp4', durationSec: 20 },
        { id: ITEM_C, sourcePath: '/c.wav', durationSec: 5 },
      ],
      done: new Set([ITEM_B]),
    });

    const result = await orchestrator.start();

    // Total reflects the whole transcribable corpus; the already-done item is
    // pre-counted as transcribed and never handed to the worker again.
    expect(result.counts.total).toBe(3);
    expect(result.counts.transcribed).toBe(1);
    const job = worker.started[0];
    expect(job.items.map((i) => i.id)).toEqual([ITEM_A, ITEM_C]);
  });

  it('does not start a second worker while a run is already in flight', async () => {
    const { orchestrator, worker } = harness({
      items: [{ id: ITEM_A, sourcePath: '/a.m4a', durationSec: 10 }],
    });

    await orchestrator.start();
    await orchestrator.start();

    expect(worker.started).toHaveLength(1);
  });

  it('forwards optional per-job and per-item language hints to the worker job spec', async () => {
    // ITEM_A omits durationSec on purpose — the job item should carry an explicit
    // `null` (the worker treats it as "unknown"), exercising the `?? null` default.
    const { orchestrator, worker } = harness({
      items: [{ id: ITEM_A, sourcePath: '/a.m4a', language: 'es' }],
      jobConfig: { ...JOB_CONFIG, language: 'qu' },
    });

    await orchestrator.start();

    const job = worker.started[0];
    expect(job.language).toBe('qu');
    expect(job.items[0].language).toBe('es');
    expect(job.items[0].durationSec).toBeNull();
  });

  it('contains a worker.start throw, logs it, and leaves the run idle for retry (#170)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { orchestrator, worker, emitted } = harness({
      items: [{ id: ITEM_A, sourcePath: '/Users/alice/private/voice.m4a', durationSec: 10 }],
    });
    worker.port.start = () => {
      throw new Error('worker crashed');
    };

    await expect(orchestrator.start()).rejects.toThrow('worker crashed');

    expect(orchestrator.status().state).toBe('idle');
    expect(orchestrator.status().counts).toEqual(ZERO_COUNTS);
    expect(emitted.at(-1)).toEqual({ state: 'idle', counts: ZERO_COUNTS, lastItem: null });
    expect(warn).toHaveBeenCalledWith(
      '[kawsay] transcription worker failed to start; run left idle for retry',
      { name: 'Error' },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/Users/alice');
    warn.mockRestore();
  });
});

describe('transcription orchestrator — stray worker events (resilience)', () => {
  it('ignores a worker event when no run is in flight (no persist, stays idle)', () => {
    const { orchestrator, lib } = harness({
      items: [{ id: ITEM_A, sourcePath: '/a.m4a', durationSec: 10 }],
    });

    // No start() ⇒ activeJobId is null; a late/duplicate event must be a calm no-op.
    orchestrator.handleWorkerEvent(
      itemDone(ITEM_A, { id: ITEM_A, status: 'transcribed', transcript: transcript() }),
    );

    expect(lib.saved).toHaveLength(0);
    expect(orchestrator.status().state).toBe('idle');
  });

  it('ignores an event tagged with a different (stale) jobId while a run is active', async () => {
    const { orchestrator, lib } = harness({
      items: [{ id: ITEM_A, sourcePath: '/a.m4a', durationSec: 10 }],
    });
    await orchestrator.start(); // activeJobId === JOB_ID

    orchestrator.handleWorkerEvent({
      jobId: 'a-stale-job',
      kind: 'progress',
      progress: {
        phase: 'item-done',
        index: 0,
        total: 1,
        id: ITEM_A,
        outcome: { id: ITEM_A, status: 'transcribed', transcript: transcript() },
      },
    });

    // The foreign event changed nothing: still running, nothing persisted.
    expect(lib.saved).toHaveLength(0);
    expect(orchestrator.status().counts.transcribed).toBe(0);
    expect(orchestrator.status().state).toBe('running');
  });
});

describe('transcription orchestrator — persist outcomes + stream progress (AC-19/AC-20)', () => {
  it('persists a transcript on success and streams advancing counts', async () => {
    const { orchestrator, lib, emitted } = harness({
      items: [{ id: ITEM_A, sourcePath: '/a.m4a', durationSec: 10 }],
    });
    await orchestrator.start();

    const t = transcript('a voice note');
    orchestrator.handleWorkerEvent({
      jobId: JOB_ID,
      kind: 'progress',
      progress: { phase: 'item-start', index: 0, total: 1, id: ITEM_A },
    });
    orchestrator.handleWorkerEvent(
      itemDone(ITEM_A, { id: ITEM_A, status: 'transcribed', transcript: t }),
    );

    expect(lib.saved).toEqual([{ itemId: ITEM_A, text: 'a voice note', language: 'en' }]);
    const last = emitted.at(-1);
    expect(last?.counts.transcribed).toBe(1);
    expect(last?.lastItem).toEqual({ id: ITEM_A, status: 'transcribed' });
  });

  it('records failed / skipped outcomes (status only, no transcript) and continues the run', async () => {
    const { orchestrator, lib } = harness({
      items: [
        { id: ITEM_A, sourcePath: '/a.m4a', durationSec: 10 },
        { id: ITEM_B, sourcePath: '/b.mp4', durationSec: 20 },
        { id: ITEM_C, sourcePath: '/c.wav', durationSec: 5 },
      ],
    });
    await orchestrator.start();

    // A hard failure, then a "no speech" skip, then a success — the run carries on.
    orchestrator.handleWorkerEvent(
      itemDone(ITEM_A, { id: ITEM_A, status: 'whisper-failed', transcript: null }),
    );
    orchestrator.handleWorkerEvent(
      itemDone(ITEM_B, { id: ITEM_B, status: 'no-speech', transcript: null }),
    );
    orchestrator.handleWorkerEvent(
      itemDone(ITEM_C, { id: ITEM_C, status: 'transcribed', transcript: transcript() }),
    );

    expect(lib.statuses).toEqual([
      { itemId: ITEM_A, status: 'failed' },
      { itemId: ITEM_B, status: 'skipped' },
    ]);
    expect(lib.saved.map((s) => s.itemId)).toEqual([ITEM_C]);
    const counts = orchestrator.status().counts;
    expect(counts).toMatchObject({ total: 3, transcribed: 1, failed: 1, skipped: 1 });
  });

  it('a persistence throw on one item never aborts the run (resilience, AC-20)', async () => {
    const saveTranscript = vi.fn((input: { itemId: string }) => {
      if (input.itemId === ITEM_A) throw new Error('disk full');
    });
    const { orchestrator, lib } = harness({
      items: [
        { id: ITEM_A, sourcePath: '/a.m4a', durationSec: 10 },
        { id: ITEM_B, sourcePath: '/b.mp4', durationSec: 20 },
      ],
      library: { saveTranscript },
    });
    await orchestrator.start();

    expect(() =>
      orchestrator.handleWorkerEvent(
        itemDone(ITEM_A, { id: ITEM_A, status: 'transcribed', transcript: transcript() }),
      ),
    ).not.toThrow();
    // The next item still persists — one bad item cannot stop the batch.
    orchestrator.handleWorkerEvent(
      itemDone(ITEM_B, { id: ITEM_B, status: 'transcribed', transcript: transcript('second') }),
    );

    expect(saveTranscript).toHaveBeenCalledTimes(2);
    expect(lib.saved.map((s) => s.itemId)).toEqual([ITEM_B]);
  });

  it('marks the run complete once every enumerated item is settled', async () => {
    const { orchestrator } = harness({
      items: [{ id: ITEM_A, sourcePath: '/a.m4a', durationSec: 10 }],
    });
    await orchestrator.start();
    orchestrator.handleWorkerEvent(
      itemDone(ITEM_A, { id: ITEM_A, status: 'transcribed', transcript: transcript() }),
    );
    orchestrator.handleWorkerEvent({
      jobId: JOB_ID,
      kind: 'done',
      summary: { total: 1, transcribed: 1, skipped: 0, cancelled: 0, outcomes: [] },
    });

    expect(orchestrator.status().state).toBe('complete');
  });

  it('still reaches complete when an item settles despite a persist throw (#160)', async () => {
    const saveTranscript = vi.fn(() => {
      throw new Error('disk full');
    });
    const { orchestrator } = harness({
      items: [{ id: ITEM_A, sourcePath: '/a.m4a', durationSec: 10 }],
      library: { saveTranscript },
    });
    await orchestrator.start();
    orchestrator.handleWorkerEvent(
      itemDone(ITEM_A, { id: ITEM_A, status: 'transcribed', transcript: transcript() }),
    );
    orchestrator.handleWorkerEvent({
      jobId: JOB_ID,
      kind: 'done',
      summary: { total: 1, transcribed: 1, skipped: 0, cancelled: 0, outcomes: [] },
    });

    // The lone item's persist threw, but it must still be COUNTED as settled so
    // the terminal snapshot reaches 'complete' (every enumerated item accounted
    // for) instead of being stuck one short at 'idle'. The unpersisted item is
    // retried idempotently on the next run.
    expect(orchestrator.status().state).toBe('complete');
    expect(orchestrator.status().counts.transcribed).toBe(1);
  });
});

describe('transcription orchestrator — cancel (AC-20: stop + persist partial)', () => {
  it('forwards a cooperative cancel to the worker and persists what already completed', async () => {
    const { orchestrator, lib, worker } = harness({
      items: [
        { id: ITEM_A, sourcePath: '/a.m4a', durationSec: 10 },
        { id: ITEM_B, sourcePath: '/b.mp4', durationSec: 20 },
      ],
    });
    await orchestrator.start();

    // One item completes and is persisted before the cancel arrives.
    orchestrator.handleWorkerEvent(
      itemDone(ITEM_A, { id: ITEM_A, status: 'transcribed', transcript: transcript() }),
    );
    const cancel = orchestrator.cancel();

    // The remaining item comes back 'cancelled' (the worker killed the in-flight child);
    // it is NOT persisted and stays eligible for the next run.
    orchestrator.handleWorkerEvent(
      itemDone(ITEM_B, { id: ITEM_B, status: 'cancelled', transcript: null }),
    );
    orchestrator.handleWorkerEvent({
      jobId: JOB_ID,
      kind: 'done',
      summary: { total: 2, transcribed: 1, skipped: 0, cancelled: 1, outcomes: [] },
    });

    expect(cancel.cancelled).toBe(true);
    expect(worker.cancelled).toEqual([JOB_ID]);
    expect(lib.saved.map((s) => s.itemId)).toEqual([ITEM_A]);
    expect(lib.statuses).toHaveLength(0);
    // Not everything settled ⇒ the run is no longer running, and is not 'complete'.
    expect(orchestrator.status().state).toBe('idle');
  });

  it('cancel with no run in flight is a calm no-op', () => {
    const { orchestrator, worker } = harness({ items: [] });
    expect(orchestrator.cancel()).toEqual({ cancelled: false });
    expect(worker.cancelled).toHaveLength(0);
  });
});

describe('transcription orchestrator — zero egress (AC-4)', () => {
  it('runs an entire start → persist cycle without any network call', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network call attempted');
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const { orchestrator } = harness({
        items: [{ id: ITEM_A, sourcePath: '/a.m4a', durationSec: 10 }],
      });
      await orchestrator.start();
      orchestrator.handleWorkerEvent(
        itemDone(ITEM_A, { id: ITEM_A, status: 'transcribed', transcript: transcript() }),
      );
      orchestrator.handleWorkerEvent({
        jobId: JOB_ID,
        kind: 'done',
        summary: { total: 1, transcribed: 1, skipped: 0, cancelled: 0, outcomes: [] },
      });
    } finally {
      globalThis.fetch = original;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
