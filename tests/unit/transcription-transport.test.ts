import { describe, expect, it } from 'vitest';
import {
  createParentPortWorkerPort,
  createWorkerThreadsHostHandle,
  createWorkerThreadsSpawner,
  type MessagePortLike,
  type WorkerLike,
} from '../../electron/main/transcription/queue/worker-threads-transport';
import type {
  HostToWorkerMessage,
  WorkerToHostMessage,
} from '../../electron/main/transcription/queue/protocol';

/** A structural worker_threads MessagePort double (message channel only). */
function fakePort() {
  let listener: ((value: unknown) => void) | undefined;
  const posted: unknown[] = [];
  const port: MessagePortLike = {
    postMessage: (v) => posted.push(v),
    on: (_event, l) => {
      listener = l;
    },
  };
  return { port, posted, deliver: (v: unknown) => listener?.(v) };
}

/**
 * A structural worker_threads `Worker` double that captures EACH lifecycle
 * listener separately (`message`, `error`, `exit`) so a test can drive a worker
 * fault — a thrown error or an abnormal exit — exactly as Node would emit it.
 */
function fakeWorker() {
  const posted: unknown[] = [];
  let messageListener: ((value: unknown) => void) | undefined;
  let errorListener: ((error: Error) => void) | undefined;
  let exitListener: ((code: number) => void) | undefined;
  let terminations = 0;
  const on = ((event: 'message' | 'error' | 'exit', listener: (arg: never) => void): void => {
    if (event === 'message') messageListener = listener as (value: unknown) => void;
    else if (event === 'error') errorListener = listener as (error: Error) => void;
    else exitListener = listener as (code: number) => void;
  }) as WorkerLike['on'];
  const worker: WorkerLike = {
    postMessage: (v) => posted.push(v),
    on,
    terminate: () => {
      terminations += 1;
    },
  };
  return {
    worker,
    posted,
    emitMessage: (v: unknown) => messageListener?.(v),
    emitError: (error: Error) => errorListener?.(error),
    emitExit: (code: number) => exitListener?.(code),
    get terminations() {
      return terminations;
    },
  };
}

describe('transcription worker_threads transport adapters (mirrors AC-9 ingestion seam)', () => {
  it('host handle posts host→worker commands and surfaces worker→host events raw', () => {
    const fake = fakeWorker();
    const handle = createWorkerThreadsHostHandle(fake.worker);

    const received: WorkerToHostMessage[] = [];
    handle.onMessage((m) => received.push(m));
    handle.post({ type: 'cancel' });
    fake.emitMessage({ type: 'ready' } satisfies WorkerToHostMessage);
    void handle.terminate();

    expect(fake.posted).toEqual([{ type: 'cancel' }]);
    expect(received).toEqual([{ type: 'ready' }]);
    expect(fake.terminations).toBe(1);
  });

  it('host handle subscribes to the worker error event (a fault never reaches the host as uncaughtException)', () => {
    const fake = fakeWorker();
    const handle = createWorkerThreadsHostHandle(fake.worker);

    const errors: Error[] = [];
    handle.onError((error) => errors.push(error));
    const fault = new Error('whisper worker fault (native/OOM/module-load)');
    fake.emitError(fault);

    expect(errors).toEqual([fault]);
  });

  it('host handle subscribes to the worker exit event (an abnormal exit can settle the batch)', () => {
    const fake = fakeWorker();
    const handle = createWorkerThreadsHostHandle(fake.worker);

    const exits: number[] = [];
    handle.onExit((code) => exits.push(code));
    fake.emitExit(1);

    expect(exits).toEqual([1]);
  });

  it('worker port posts worker→host events and surfaces host→worker commands raw', () => {
    const fake = fakePort();
    const port = createParentPortWorkerPort(fake.port);

    const received: HostToWorkerMessage[] = [];
    port.onMessage((m) => received.push(m));
    port.post({ type: 'ready' });
    fake.deliver({ type: 'cancel' } satisfies HostToWorkerMessage);

    expect(fake.posted).toEqual([{ type: 'ready' }]);
    expect(received).toEqual([{ type: 'cancel' }]);
  });

  it('spawner forks a fresh worker per call via the injected factory', () => {
    const made: string[] = [];
    const createWorker = (scriptPath: string): WorkerLike => {
      made.push(scriptPath);
      return { postMessage: () => {}, on: () => {}, terminate: () => {} };
    };
    const spawn = createWorkerThreadsSpawner({
      scriptPath: '/out/main/transcription-worker.js',
      createWorker,
    });

    spawn();
    spawn();
    expect(made).toEqual([
      '/out/main/transcription-worker.js',
      '/out/main/transcription-worker.js',
    ]);
  });
});
