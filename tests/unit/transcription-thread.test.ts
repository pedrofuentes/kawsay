import { describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createTranscriptionCoordinator } from '../../electron/main/transcription/queue/coordinator';
import type { TranscriptionCoordinatorEvent } from '../../electron/main/transcription/queue/coordinator';
import { createWorkerThreadsHostHandle } from '../../electron/main/transcription/queue/worker-threads-transport';
import type { TranscriptionJobSpec } from '../../electron/main/transcription/queue/protocol';

const HARNESS = fileURLToPath(new URL('./transcription-thread-harness.mjs', import.meta.url));
const JOB_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const TOTAL = 3;

function job(): TranscriptionJobSpec {
  return {
    jobId: JOB_ID,
    items: [
      { id: 'a', sourcePath: '/src/a.opus' },
      { id: 'b', sourcePath: '/src/b.opus' },
      { id: 'c', sourcePath: '/src/c.opus' },
    ],
    modelPath: '/models/ggml-small.bin',
    whisperCliPath: '/bin/whisper-cli',
    ffmpegPath: '/bin/ffmpeg',
    scratchDir: '/scratch',
  };
}

/** Run one real-thread batch, returning the streamed events and a promise that
 *  resolves when the OS thread has actually exited (the teardown proof). */
function runOnRealThread(
  onFirstProgress?: (coordinator: ReturnType<typeof createTranscriptionCoordinator>) => void,
) {
  const worker = new Worker(HARNESS);
  const exited = new Promise<void>((resolve) => worker.on('exit', () => resolve()));
  const events: TranscriptionCoordinatorEvent[] = [];
  let sawFirstProgress = false;

  const coordinator = createTranscriptionCoordinator({
    spawn: () => createWorkerThreadsHostHandle(worker),
    emit: (event) => {
      events.push(event);
      if (event.kind === 'progress' && !sawFirstProgress) {
        sawFirstProgress = true;
        onFirstProgress?.(coordinator);
      }
    },
  });

  const done = new Promise<TranscriptionCoordinatorEvent>((resolve) => {
    const timer = setInterval(() => {
      const terminal = events.find((e) => e.kind === 'done' || e.kind === 'error');
      if (terminal !== undefined) {
        clearInterval(timer);
        resolve(terminal);
      }
    }, 5);
  });

  coordinator.start(job());
  return { coordinator, events, done, exited };
}

describe('transcription over a real worker_threads thread (AC-18 off-thread proof)', () => {
  it('streams progress off-thread and tears the thread down on completion', async () => {
    const { coordinator, events, done, exited } = runOnRealThread();

    const terminal = await done;
    await exited; // the OS thread genuinely exited — no orphaned worker

    const progress = events.filter((e) => e.kind === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.jobId).toBe(JOB_ID);
    }
    expect(terminal.kind).toBe('done');
    if (terminal.kind === 'done') {
      expect(terminal.summary.cancelled).toBe(0);
      expect(terminal.summary.transcribed).toBe(TOTAL);
      expect(terminal.summary.total).toBe(TOTAL);
    }
    expect(coordinator.active()).toEqual([]);
  }, 15000);

  it('cancels mid-stream on a real thread and stops gracefully (partial cancelled summary)', async () => {
    const { coordinator, done, exited } = runOnRealThread((c) => c.cancel(JOB_ID));

    const terminal = await done;
    await exited;

    expect(terminal.kind).toBe('done');
    if (terminal.kind === 'done') {
      expect(terminal.summary.cancelled).toBeGreaterThan(0);
      expect(terminal.summary.transcribed).toBeLessThan(TOTAL); // stopped early
    }
    expect(coordinator.active()).toEqual([]);
  }, 15000);
});
