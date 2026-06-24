import { describe, expect, it, vi } from 'vitest';
import {
  createParentPortWorkerPort,
  createWorkerThreadsHostHandle,
  createWorkerThreadsSpawner,
  type MessagePortLike,
  type WorkerLike,
} from '../../electron/main/importers/ingestion/worker-threads-transport';
import type {
  HostToWorkerMessage,
  WorkerToHostMessage,
} from '../../electron/main/importers/ingestion/protocol';

/** A structural worker_threads MessagePort double. */
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

describe('worker_threads transport adapters', () => {
  it('host handle posts host→worker commands and surfaces worker→host events raw', () => {
    const fake = fakePort();
    const terminate = vi.fn(() => Promise.resolve(0));
    const worker: WorkerLike = { ...fake.port, terminate };
    const handle = createWorkerThreadsHostHandle(worker);

    const received: WorkerToHostMessage[] = [];
    handle.onMessage((m) => received.push(m));
    handle.post({ type: 'cancel' });
    fake.deliver({ type: 'ready' } satisfies WorkerToHostMessage);
    void handle.terminate();

    expect(fake.posted).toEqual([{ type: 'cancel' }]);
    expect(received).toEqual([{ type: 'ready' }]);
    expect(terminate).toHaveBeenCalledTimes(1);
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
    const spawn = createWorkerThreadsSpawner({ scriptPath: '/out/main/ingestion-worker.js', createWorker });

    spawn();
    spawn();
    expect(made).toEqual(['/out/main/ingestion-worker.js', '/out/main/ingestion-worker.js']);
  });
});
