import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startTranscriptionJob,
  type TranscriptionContext,
} from '../../electron/main/transcription/workers/transcription-job';
import type {
  HostToWorkerMessage,
  TranscriptionJobSpec,
  WorkerPort,
  WorkerToHostMessage,
} from '../../electron/main/transcription/queue/protocol';
import type {
  TranscribeContext,
  TranscribeItem,
  TranscribeResult,
  Transcriber,
} from '../../electron/main/transcription/transcribe';

function spec(overrides: Partial<TranscriptionJobSpec> = {}): TranscriptionJobSpec {
  return {
    jobId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
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

function ok(id: string): TranscribeResult {
  return { ok: true, id, transcript: { text: `text-${id}`, language: 'es', segments: [] } };
}

/** A {@link Transcriber} that runs `impl`, recording each id + the forwarded signal. */
function recordingTranscribe(
  impl: (item: TranscribeItem, ctx?: TranscribeContext) => TranscribeResult | Promise<TranscribeResult>,
): Transcriber & { calls: { id: string; signal?: AbortSignal }[] } {
  const calls: { id: string; signal?: AbortSignal }[] = [];
  const fn = (async (item: TranscribeItem, ctx?: TranscribeContext) => {
    calls.push({ id: item.id, signal: ctx?.signal });
    return impl(item, ctx);
  }) as Transcriber & { calls: { id: string; signal?: AbortSignal }[] };
  fn.calls = calls;
  return fn;
}

/** A fake WorkerPort: records what the job posts and lets the test deliver
 *  host→worker commands, with a small awaiter for the terminal message. */
function fakePort() {
  let onMsg: ((m: HostToWorkerMessage) => void) | undefined;
  const sent: WorkerToHostMessage[] = [];
  const waiters: { type: WorkerToHostMessage['type']; resolve: () => void }[] = [];
  const port: WorkerPort = {
    post: (m) => {
      sent.push(m);
      for (const w of waiters) if (w.type === m.type) w.resolve();
    },
    onMessage: (h) => {
      onMsg = h;
    },
  };
  return {
    port,
    sent,
    deliver: (m: HostToWorkerMessage) => onMsg?.(m),
    waitFor: (type: WorkerToHostMessage['type']) =>
      new Promise<void>((resolve) => {
        if (sent.some((m) => m.type === type)) resolve();
        else waiters.push({ type, resolve });
      }),
  };
}

describe('startTranscriptionJob (worker-side batch drive — AC-18/AC-20)', () => {
  const closers: ReturnType<typeof vi.fn>[] = [];
  afterEach(() => closers.splice(0));

  function context(transcribe: Transcriber): TranscriptionContext {
    const close = vi.fn();
    closers.push(close);
    return { transcribe, close };
  }

  it('announces ready, runs the batch off the message loop, streams progress, then done', async () => {
    const transcribe = recordingTranscribe((item) => ok(item.id));
    const ctx = context(transcribe);
    const port = fakePort();

    startTranscriptionJob({ port: port.port, openContext: () => ctx });
    expect(port.sent).toEqual([{ type: 'ready' }]); // ready before any job

    port.deliver({ type: 'start', job: spec() });
    await port.waitFor('done');

    const progress = port.sent.filter((m) => m.type === 'progress');
    expect(progress.length).toBeGreaterThan(0); // streamed per-item lifecycle
    const done = port.sent.at(-1);
    expect(done).toMatchObject({ type: 'done' });
    if (done?.type === 'done') {
      expect(done.summary.total).toBe(2);
      expect(done.summary.transcribed).toBe(2);
      expect(done.summary.cancelled).toBe(0);
    }
    expect(ctx.close).toHaveBeenCalledTimes(1); // context torn down
  });

  it('passes the items from the job spec through to the executor', async () => {
    const transcribe = recordingTranscribe((item) => ok(item.id));
    const port = fakePort();

    startTranscriptionJob({ port: port.port, openContext: () => context(transcribe) });
    port.deliver({ type: 'start', job: spec() });
    await port.waitFor('done');

    expect(transcribe.calls.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('honours a port-driven cancel mid-run: forwards the kill signal, partial cancelled summary, no throw', async () => {
    const port = fakePort();
    // Cancel arrives WHILE the first item is in flight; the executor sees the
    // aborted signal (in production it kills the whisper-cli child) and the batch
    // stops dispatching the rest.
    const transcribe = recordingTranscribe((item) => {
      if (item.id === 'a') {
        port.deliver({ type: 'cancel' });
        return { ok: false, id: 'a', reason: 'cancelled', message: 'killed' };
      }
      return ok(item.id);
    });

    startTranscriptionJob({ port: port.port, openContext: () => context(transcribe) });
    port.deliver({ type: 'start', job: spec() });
    await port.waitFor('done');

    expect(transcribe.calls.map((c) => c.id)).toEqual(['a']); // 'b' never dispatched
    expect(transcribe.calls[0].signal?.aborted).toBe(true); // the kill signal was forwarded
    const done = port.sent.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.summary.cancelled).toBe(2);
      expect(done.summary.transcribed).toBe(0);
    }
  });

  it('reports an engine failure as an error message and still tears down (finally-close)', async () => {
    const ctx = context(recordingTranscribe((item) => ok(item.id)));
    const port = fakePort();

    startTranscriptionJob({
      port: port.port,
      openContext: () => ctx,
      runBatch: async () => {
        throw new Error('boom');
      },
    });
    port.deliver({ type: 'start', job: spec() });
    await port.waitFor('error');

    expect(port.sent.at(-1)).toEqual({ type: 'error', message: 'boom' });
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('reports a failed context open as an error message', async () => {
    const port = fakePort();

    startTranscriptionJob({
      port: port.port,
      openContext: () => {
        throw new Error('whisper-cli not found');
      },
    });
    port.deliver({ type: 'start', job: spec() });
    await port.waitFor('error');

    expect(port.sent.at(-1)).toEqual({ type: 'error', message: 'whisper-cli not found' });
  });

  it('ignores a second start (one batch per worker)', async () => {
    const ctx = context(recordingTranscribe((item) => ok(item.id)));
    const port = fakePort();

    startTranscriptionJob({ port: port.port, openContext: () => ctx });
    port.deliver({ type: 'start', job: spec() });
    port.deliver({ type: 'start', job: spec() });
    await port.waitFor('done');

    expect(port.sent.filter((m) => m.type === 'done')).toHaveLength(1);
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });
});
