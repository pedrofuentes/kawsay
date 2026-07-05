// Unit tests for the categorization worker glue (T-M4-2g / #269): the pure
// request→response cluster runner, the inline transport, the worker-side binding,
// and the worker_thread transport driven entirely by a fake in-process Worker/port
// (no real thread is spawned). Proves the request marshalling round-trip, teardown,
// and the error/exit fault paths — mirroring the transcription transport seam.

import { describe, expect, it, vi } from 'vitest';

import { clusterPlaces } from '../../electron/main/categorize/places-cluster';
import { clusterThemes } from '../../electron/main/categorize/themes-cluster';
import {
  bindClusterWorker,
  createInlineClusterTransport,
  createWorkerThreadClusterTransport,
  runClusterRequest,
} from '../../electron/main/categorize/categorization-worker';
import type { ClusterRequest } from '../../electron/main/categorize/categorization-orchestrator';
import type {
  MessagePortLike,
  WorkerLike,
} from '../../electron/main/transcription/queue/worker-threads-transport';

function vec(fill: number): Float32Array {
  return Float32Array.from({ length: 8 }, () => fill);
}

const PLACES_INPUT = {
  points: [
    { id: 'a', lat: -13.532, lon: -71.9675 },
    { id: 'b', lat: -13.5325, lon: -71.968 },
  ],
  options: { epsMeters: 2000, minPts: 2 },
};

const THEMES_INPUT = {
  items: [
    { id: 't1', vector: vec(0.5) },
    { id: 't2', vector: vec(0.5) },
  ],
  options: { minClusterSize: 2 },
};

const PLACES_REQUEST: ClusterRequest = { places: PLACES_INPUT };

const BOTH_REQUEST: ClusterRequest = { places: PLACES_INPUT, themes: THEMES_INPUT };

// A fake Worker/MessagePort linked in-process: messages posted to the worker are
// delivered to the port's listeners and vice-versa (deep-cloned to emulate the
// structured-clone boundary). Lets us drive both transport directions synchronously.
function linkedWorker(): {
  worker: WorkerLike;
  port: MessagePortLike;
  terminate: ReturnType<typeof vi.fn>;
  fireError: (error: Error) => void;
  fireExit: (code: number) => void;
} {
  const hostMessage: ((value: unknown) => void)[] = [];
  const hostError: ((error: Error) => void)[] = [];
  const hostExit: ((code: number) => void)[] = [];
  const workerMessage: ((value: unknown) => void)[] = [];
  const terminate = vi.fn();

  const port = {
    postMessage: (value: unknown) => {
      for (const handler of hostMessage) handler(structuredClone(value));
    },
    on: (event: 'message', listener: (value: unknown) => void) => {
      if (event === 'message') workerMessage.push(listener);
    },
  } as unknown as MessagePortLike;

  const worker = {
    postMessage: (value: unknown) => {
      for (const handler of workerMessage) handler(structuredClone(value));
    },
    on: (event: string, listener: (arg: never) => void) => {
      if (event === 'message') hostMessage.push(listener as (value: unknown) => void);
      else if (event === 'error') hostError.push(listener as (error: Error) => void);
      else if (event === 'exit') hostExit.push(listener as (code: number) => void);
    },
    terminate,
  } as unknown as WorkerLike;

  return {
    worker,
    port,
    terminate,
    fireError: (error) => {
      for (const handler of [...hostError]) handler(error);
    },
    fireExit: (code) => {
      for (const handler of [...hostExit]) handler(code);
    },
  };
}

describe('runClusterRequest', () => {
  it('runs whichever passes are present and matches the leaf modules exactly', () => {
    const response = runClusterRequest(BOTH_REQUEST);
    expect(response.places).toEqual(clusterPlaces(PLACES_INPUT.points, PLACES_INPUT.options));
    expect(response.themes).toEqual(clusterThemes(THEMES_INPUT.items, THEMES_INPUT.options));
  });

  it('omits a pass whose input is absent', () => {
    const response = runClusterRequest(PLACES_REQUEST);
    expect(response.places).toBeDefined();
    expect(response.themes).toBeUndefined();
  });
});

describe('createInlineClusterTransport', () => {
  it('resolves to the same result as runClusterRequest', async () => {
    const transport = createInlineClusterTransport();
    await expect(transport.run(BOTH_REQUEST)).resolves.toEqual(runClusterRequest(BOTH_REQUEST));
  });
});

describe('createWorkerThreadClusterTransport', () => {
  it('marshals the request to the worker and resolves with its clustered reply, then tears down', async () => {
    const link = linkedWorker();
    bindClusterWorker(link.port);
    const transport = createWorkerThreadClusterTransport({
      scriptPath: 'unused.js',
      createWorker: () => link.worker,
    });

    const response = await transport.run(BOTH_REQUEST);

    expect(response.places?.clusters.map((c) => [...c.memberIds])).toEqual(
      clusterPlaces(PLACES_INPUT.points, PLACES_INPUT.options).clusters.map((c) => [
        ...c.memberIds,
      ]),
    );
    expect(response.themes?.clusters[0].sourceKey).toBe(
      clusterThemes(THEMES_INPUT.items, THEMES_INPUT.options).clusters[0].sourceKey,
    );
    expect(link.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects and tears down when the worker surfaces a bound error reply', async () => {
    const link = linkedWorker();
    bindClusterWorker(link.port);
    // Force the worker-side runner to throw: a duplicate theme id trips clusterThemes.
    const transport = createWorkerThreadClusterTransport({
      scriptPath: 'unused.js',
      createWorker: () => link.worker,
    });

    const badRequest: ClusterRequest = {
      themes: {
        items: [
          { id: 'dup', vector: vec(0.5) },
          { id: 'dup', vector: vec(0.5) },
        ],
        options: { minClusterSize: 2 },
      },
    };

    await expect(transport.run(badRequest)).rejects.toThrow();
    expect(link.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects when the worker emits a thread-level error event', async () => {
    const link = linkedWorker();
    // Do NOT bind the port ⇒ no reply is produced; the error event settles the run.
    const transport = createWorkerThreadClusterTransport({
      scriptPath: 'unused.js',
      createWorker: () => link.worker,
    });

    const pending = transport.run(PLACES_REQUEST);
    link.fireError(new Error('native crash'));

    await expect(pending).rejects.toThrow('native crash');
    expect(link.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects when the worker exits before replying', async () => {
    const link = linkedWorker();
    const transport = createWorkerThreadClusterTransport({
      scriptPath: 'unused.js',
      createWorker: () => link.worker,
    });

    const pending = transport.run(PLACES_REQUEST);
    link.fireExit(1);

    await expect(pending).rejects.toThrow(/exited/);
    expect(link.terminate).toHaveBeenCalledTimes(1);
  });
});
