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
  createProductionClusterTransport,
  createWorkerThreadClusterTransport,
  runClusterRequest,
} from '../../electron/main/categorize/categorization-worker';
import { bindCategorizationClusterWorkerEntry } from '../../electron/main/categorize/workers/categorization-cluster-worker';
import { createCancelFlaggedCategorizationPort } from '../../electron/main/categorize/categorization-cancel-flag';
import type {
  ClusterWorkerReply,
  ClusterWorkerRequest,
} from '../../electron/main/categorize/categorization-worker';
import type {
  CategorizationRunResult,
  ClusterRequest,
} from '../../electron/main/categorize/categorization-orchestrator';
import type { CategorizationLibraryPort } from '../../electron/main/categorize/categorization-library';
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

describe('createInlineClusterTransport (cooperative yield + cancel — #344 interim)', () => {
  // The interim fix for #344: the inline transport must cooperatively surrender
  // the event loop between cluster passes so the Electron main process can service
  // pending IPC (crucially `categorize:cancel`) instead of stalling until the whole
  // clustering pass returns. It must also honor a cancel probe at each yield point
  // so a cancel requested mid-pass stops further slices, and — when NOT cancelled —
  // its output must be byte-for-byte identical to `runClusterRequest`.

  it('yields via a macrotask (setImmediate) so a pending macrotask runs mid-transport', async () => {
    // A macrotask queued BEFORE `run()` cannot fire until the transport actually
    // surrenders to the event loop's macrotask queue. `Promise.resolve(value)`
    // (the pre-fix wrapper) only creates a microtask — macrotasks stay starved
    // until the whole async function drains. Proving this handler runs during
    // `transport.run(...)` proves the transport yields via `setImmediate`
    // (or equivalent) between passes.
    let handlerFiredBeforeRunFinished = false;
    let runFinished = false;
    setImmediate(() => {
      handlerFiredBeforeRunFinished = !runFinished;
    });

    const transport = createInlineClusterTransport();
    await transport.run(BOTH_REQUEST);
    runFinished = true;

    // One more macrotask tick to let the assertion see the flip.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handlerFiredBeforeRunFinished).toBe(true);
  });

  it('honors an isCancelled probe at yield points: cancel flipped mid-run skips further passes', async () => {
    // Cancel is flipped the first time the transport yields, so at least one
    // subsequent pass must be skipped. Proves both that the injected yield is
    // actually invoked AND that the transport re-checks the cancel probe
    // after each yield (never blindly running every pass to completion).
    let cancelled = false;
    const transport = createInlineClusterTransport({
      isCancelled: () => cancelled,
      yield: async () => {
        cancelled = true;
      },
    });

    const response = await transport.run(BOTH_REQUEST);

    // themes runs after places (or is the only pass); a cancel observed at any
    // yield point MUST prevent the themes pass from writing a result.
    expect(response.themes).toBeUndefined();
    // Pin the "yield BEFORE places" contract (#378): a regression that moves
    // `response.places = clusterPlaces(...)` BEFORE its `await yieldOnce()`
    // (degrading places-phase IPC responsiveness) would leave `places` defined
    // while `themes` stays undefined — this assertion catches it.
    expect(response.places).toBeUndefined();
  });

  it('honors an isCancelled probe at yield points: cancel flipped between passes runs places, skips themes', async () => {
    // Cover the cancel-BETWEEN-passes branch (#379): a stateful yield flips
    // cancel only on its 2nd call, so the places pass runs to completion and
    // the themes pass is skipped. A regression that yields+checks cancel only
    // ONCE (before all passes) — eliminating the inter-pass responsiveness
    // window the interim fix advertises — would leave `themes` defined.
    let cancelled = false;
    let yieldCount = 0;
    const transport = createInlineClusterTransport({
      isCancelled: () => cancelled,
      yield: async () => {
        yieldCount += 1;
        if (yieldCount === 2) cancelled = true;
      },
    });

    const response = await transport.run(BOTH_REQUEST);

    expect(response.places).toBeDefined();
    expect(response.themes).toBeUndefined();
  });

  it('preserves deterministic output when isCancelled always returns false (parity with runClusterRequest)', async () => {
    // With a probe that never signals cancel and the injected yield still firing,
    // the resulting clusters MUST be byte-for-byte identical to the pure runner —
    // yielding must not perturb determinism (AC3 of the interim fix).
    const transport = createInlineClusterTransport({
      isCancelled: () => false,
      yield: async () => {},
    });
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

  it('ignores a terminate-triggered exit that arrives AFTER a successful result (settled guard, #341)', async () => {
    const link = linkedWorker();
    bindClusterWorker(link.port);
    const transport = createWorkerThreadClusterTransport({
      scriptPath: 'unused.js',
      createWorker: () => link.worker,
    });

    // The run resolves on the worker's `result` reply; `finish` flips `settled` and
    // terminates the worker exactly once.
    const response = await transport.run(PLACES_REQUEST);
    expect(response.places).toBeDefined();
    expect(link.terminate).toHaveBeenCalledTimes(1);

    // A REAL worker fires `exit` shortly after terminate(). That late exit MUST be
    // swallowed by the `settled` guard: it must neither re-terminate the worker nor
    // reject the already-resolved promise (which would surface as an unhandled
    // rejection). Without the guard, this exit would call terminate a 2nd time.
    expect(() => link.fireExit(0)).not.toThrow();
    expect(link.terminate).toHaveBeenCalledTimes(1);
    // The resolved value is unaffected by the late exit.
    await expect(Promise.resolve(response)).resolves.toBe(response);
  });

  it('rejects and tears down when the worker replies with an unrecognized message type (must not hang the drain)', async () => {
    const link = linkedWorker();
    // Deliberately DO NOT bind the port — we drive the transport with a hand-crafted
    // bogus reply, simulating a misbehaving/incompatible worker entry (once #270 lands).
    const transport = createWorkerThreadClusterTransport({
      scriptPath: 'unused.js',
      createWorker: () => link.worker,
    });

    const pending = transport.run(PLACES_REQUEST);
    // Post a reply whose `type` is neither `result` nor `error`. Before the fix this
    // path silently ignores the message and the promise never settles, which would
    // permanently wedge the orchestrator's drain (every later run returns `busy`).
    link.port.postMessage({ type: 'garbage', payload: { anything: true } });

    await expect(pending).rejects.toThrow();
    expect(link.terminate).toHaveBeenCalledTimes(1);

    // Prove the transport is reusable: a fresh run on a fresh worker still resolves,
    // i.e. the earlier bogus reply did not corrupt subsequent runs.
    const link2 = linkedWorker();
    bindClusterWorker(link2.port);
    const transport2 = createWorkerThreadClusterTransport({
      scriptPath: 'unused.js',
      createWorker: () => link2.worker,
    });
    await expect(transport2.run(PLACES_REQUEST)).resolves.toBeDefined();
  });

  it('terminates the in-flight worker and resolves with an empty response on a mid-run cancel (#402)', async () => {
    const link = linkedWorker();
    // Deliberately DO NOT bind the port ⇒ the worker never posts a result; the ONLY
    // settle path is the injected cancel poll, so the assertion isolates cancellation.
    let cancelled = false;
    let poll: (() => void) | undefined;
    const stopPoll = vi.fn();
    const transport = createWorkerThreadClusterTransport({
      scriptPath: 'unused.js',
      createWorker: () => link.worker,
      isCancelled: () => cancelled,
      startCancelPoll: (onPoll) => {
        poll = onPoll;
        return stopPoll;
      },
    });

    const pending = transport.run(PLACES_REQUEST);

    if (poll === undefined) throw new Error('expected the transport to start a cancel poll');
    // A poll tick BEFORE cancel must not settle the run or tear anything down.
    poll();
    expect(stopPoll).not.toHaveBeenCalled();
    expect(link.terminate).not.toHaveBeenCalled();

    // Cancel is requested; the next poll tick must terminate the worker and settle
    // as cancelled — resolving (a cancel is not a failure), not rejecting.
    cancelled = true;
    poll();

    const response = await pending;
    expect(response).toEqual({});
    expect(link.terminate).toHaveBeenCalledTimes(1);
    // The poll timer is cleared exactly once on the cancel settle path (no leak).
    expect(stopPoll).toHaveBeenCalledTimes(1);

    // A late worker exit after the cancel settle MUST be swallowed by the guard:
    // no double-settle, no second terminate, no second poll-stop.
    expect(() => link.fireExit(0)).not.toThrow();
    expect(link.terminate).toHaveBeenCalledTimes(1);
    expect(stopPoll).toHaveBeenCalledTimes(1);
  });

  it('stops the cancel poll and resolves with the worker result when no cancel is signalled (#402)', async () => {
    const link = linkedWorker();
    bindClusterWorker(link.port);
    const stopPoll = vi.fn();
    const transport = createWorkerThreadClusterTransport({
      scriptPath: 'unused.js',
      createWorker: () => link.worker,
      isCancelled: () => false,
      startCancelPoll: () => stopPoll,
    });

    const response = await transport.run(PLACES_REQUEST);

    // The non-cancel path is unchanged: the worker's result resolves the run and the
    // worker is torn down once — and the cancel poll is cleared so no timer leaks.
    expect(response.places).toBeDefined();
    expect(link.terminate).toHaveBeenCalledTimes(1);
    expect(stopPoll).toHaveBeenCalledTimes(1);
  });

  it('does not start a cancel poll when no isCancelled probe is provided (#402)', async () => {
    const link = linkedWorker();
    bindClusterWorker(link.port);
    let pollStarted = false;
    const transport = createWorkerThreadClusterTransport({
      scriptPath: 'unused.js',
      createWorker: () => link.worker,
      startCancelPoll: () => {
        pollStarted = true;
        return () => {};
      },
    });

    await transport.run(PLACES_REQUEST);

    // With no cancel probe there is nothing to poll for — the seam must stay unused.
    expect(pollStarted).toBe(false);
  });
});

describe('categorization cluster worker bootstrap entry (#344 off-thread wiring)', () => {
  // The top-level worker ENTRY (out/main/categorization-cluster-worker.js) that
  // electron-vite builds and the host forks with worker_threads. It must bind the
  // shared `bindClusterWorker` onto the real `parentPort` — proven here with a fake
  // in-process port (no real thread) — and refuse to run on the main thread.

  it('binds bindClusterWorker onto the parent port and round-trips a cluster request→result', () => {
    const posts: unknown[] = [];
    const listeners: ((value: unknown) => void)[] = [];

    bindCategorizationClusterWorkerEntry({
      parentPort: {
        postMessage: (value) => posts.push(value),
        on: (_event, listener) => listeners.push(listener),
      },
    });

    expect(listeners).toHaveLength(1);

    const request: ClusterWorkerRequest = { type: 'cluster', request: PLACES_REQUEST };
    listeners[0](request);

    expect(posts).toHaveLength(1);
    const reply = posts[0] as ClusterWorkerReply;
    if (reply.type !== 'result') throw new Error(`expected a result reply, got ${reply.type}`);
    expect(reply.response.places).toBeDefined();
    expect(reply.response.places?.clusters.map((c) => [...c.memberIds])).toEqual(
      clusterPlaces(PLACES_INPUT.points, PLACES_INPUT.options).clusters.map((c) => [
        ...c.memberIds,
      ]),
    );
  });

  it('refuses to run without a parent worker port (never on the main thread)', () => {
    expect(() => bindCategorizationClusterWorkerEntry({ parentPort: null })).toThrow(
      'categorization-cluster-worker must be run as a worker thread',
    );
  });
});

describe('createProductionClusterTransport (#344 worker transport with inline fallback)', () => {
  // The production wiring seam: prefer the real off-thread worker_thread transport
  // when the built worker entry resolves, and degrade — lazily and non-throwing,
  // mirroring the ffmpeg/embedder degrade — to the in-process inline transport when
  // it doesn't (dev/CI without a built worker). The `scriptExists` + `createWorker`
  // seams keep this drivable in-process, so no real OS thread is spawned here.

  it('selects the worker-thread transport when the built worker script resolves', async () => {
    const link = linkedWorker();
    bindClusterWorker(link.port);
    let created = 0;
    let probedPath: string | undefined;
    const transport = createProductionClusterTransport({
      scriptPath: '/out/main/categorization-cluster-worker.js',
      scriptExists: (path) => {
        probedPath = path;
        return true;
      },
      createWorker: () => {
        created += 1;
        return link.worker;
      },
    });

    const response = await transport.run(PLACES_REQUEST);

    expect(probedPath).toBe('/out/main/categorization-cluster-worker.js');
    expect(created).toBe(1);
    expect(link.terminate).toHaveBeenCalledTimes(1);
    expect(response.places).toBeDefined();
  });

  it('falls back to the inline transport when the worker script cannot be resolved', async () => {
    let created = 0;
    const transport = createProductionClusterTransport({
      scriptPath: '/out/main/categorization-cluster-worker.js',
      scriptExists: () => false,
      createWorker: () => {
        created += 1;
        throw new Error('must not spawn a worker on the inline fallback path');
      },
    });

    const response = await transport.run(BOTH_REQUEST);

    expect(created).toBe(0);
    expect(response).toEqual(runClusterRequest(BOTH_REQUEST));
  });

  it('threads the cancel probe into the inline fallback transport', async () => {
    // A cancel already set at entry skips both passes (the inline transport
    // contract) — proving the fallback carries the host cancel flag through.
    const transport = createProductionClusterTransport({
      scriptPath: '/out/main/categorization-cluster-worker.js',
      scriptExists: () => false,
      isCancelled: () => true,
    });

    const response = await transport.run(BOTH_REQUEST);

    expect(response.places).toBeUndefined();
    expect(response.themes).toBeUndefined();
  });

  it('warns once about the degraded inline fallback when the worker entry is missing (#401)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const transport = createProductionClusterTransport({
        scriptPath: '/out/main/categorization-cluster-worker.js',
        scriptExists: () => false,
      });

      // Constructing the transport (once per port) emits a single degraded-mode warning.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[kawsay] categorization worker entry missing; falling back to inline main-thread clustering',
      );
      // Zero-egress diagnostics: the message must NOT leak the worker script path.
      const logged = warn.mock.calls[0]?.[0];
      expect(String(logged)).not.toContain('categorization-cluster-worker.js');

      // The degraded transport still works — it is the inline main-thread one.
      await expect(transport.run(BOTH_REQUEST)).resolves.toEqual(runClusterRequest(BOTH_REQUEST));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when the worker entry resolves (#401)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const link = linkedWorker();
      bindClusterWorker(link.port);
      const transport = createProductionClusterTransport({
        scriptPath: '/out/main/categorization-cluster-worker.js',
        scriptExists: () => true,
        createWorker: () => link.worker,
      });

      await transport.run(PLACES_REQUEST);

      // The healthy off-thread path must stay silent (no degraded-mode noise).
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('threads the cancel probe into the worker transport so a mid-run cancel stops the worker (#402)', async () => {
    const link = linkedWorker();
    // Unbound port ⇒ the worker never replies; the forwarded cancel poll settles the run.
    let cancelled = false;
    let poll: (() => void) | undefined;
    const stopPoll = vi.fn();
    const transport = createProductionClusterTransport({
      scriptPath: '/out/main/categorization-cluster-worker.js',
      scriptExists: () => true,
      isCancelled: () => cancelled,
      createWorker: () => link.worker,
      startCancelPoll: (onPoll) => {
        poll = onPoll;
        return stopPoll;
      },
    });

    const pending = transport.run(PLACES_REQUEST);

    if (poll === undefined) {
      throw new Error('expected the production worker path to forward the cancel probe');
    }
    cancelled = true;
    poll();

    const response = await pending;
    expect(response).toEqual({});
    expect(link.terminate).toHaveBeenCalledTimes(1);
    expect(stopPoll).toHaveBeenCalledTimes(1);
  });
});

describe('createCancelFlaggedCategorizationPort (#377 start→cancel→start race hardening)', () => {
  // The interim off-thread cancel path in `electron/main/index.ts` wraps the
  // categorization port with a host-owned `cancelRequested` flag: `start` clears
  // it, `cancel` sets it, and the inline transport probes it at each yield.
  //
  // Regression (#377): a `categorize:cancel` followed by a `categorize:start`
  // serviced in the same event-loop poll phase — BEFORE the in-flight yield's
  // pending macrotask fires — flipped the flag `true → false`; the underlying
  // orchestrator single-flight'd the second start as `busy` without beginning
  // a new run, and the in-flight yield then read `false` and burned through
  // the remaining pass wastefully. The wrapper MUST restore the flag when
  // `port.start()` returns `busy` so an in-flight cancel stays armed.

  const zeroCounts = {
    categorized: 0,
    skipped: 0,
    failed: 0,
    inFlight: 0,
  } as const;

  function busyResult(): CategorizationRunResult {
    return { outcome: 'busy', reason: null, counts: { ...zeroCounts } };
  }

  function cancelledResult(): CategorizationRunResult {
    return { outcome: 'cancelled', reason: null, counts: { ...zeroCounts } };
  }

  function completedResult(): CategorizationRunResult {
    return {
      outcome: 'completed',
      reason: null,
      counts: { ...zeroCounts, categorized: 1 },
    };
  }

  /**
   * A minimal fake {@link CategorizationLibraryPort} whose `start()` mimics the
   * orchestrator's single-flight contract: the first call marks the run as
   * "in-flight" and awaits an externally-controlled promise, and any concurrent
   * `start()` returns `busy` synchronously (as an async function resolves the
   * short-circuit in a microtask). The `isCancelled` probe the wrapper passes
   * to the port factory is captured on the returned handle so a test can
   * inspect the flag from outside.
   */
  function fakePort(): {
    build: (isCancelled: () => boolean) => CategorizationLibraryPort;
    release: (result?: CategorizationRunResult) => void;
    probe: () => boolean;
  } {
    let running = false;
    let releaseFirstRun: (result: CategorizationRunResult) => void = () => {};
    let capturedProbe: () => boolean = () => false;
    return {
      probe: () => capturedProbe(),
      release: (result = cancelledResult()) => releaseFirstRun(result),
      build: (isCancelled) => {
        capturedProbe = isCancelled;
        return {
          listForItem: () => [],
          applyCorrection: () => [],
          status: () => ({
            state: 'idle',
            counts: { ...zeroCounts },
            lastItem: null,
          }),
          start: async () => {
            if (running) return busyResult();
            running = true;
            try {
              return await new Promise<CategorizationRunResult>((resolve) => {
                releaseFirstRun = resolve;
              });
            } finally {
              running = false;
            }
          },
          cancel: () => ({ cancelled: true }),
        };
      },
    };
  }

  it('keeps the cancel flag armed when a second start hits the single-flight busy short-circuit', async () => {
    const port = fakePort();
    const wrapper = createCancelFlaggedCategorizationPort(port.build);

    // Kick off the in-flight "run" (the fake awaits an externally-controlled
    // promise so we can freeze it mid-flight).
    const firstRun = wrapper.start();
    // Let the wrapper's `start` body run past its `await port.start()` so the
    // fake's `running = true` is committed before the racing cancel/start.
    await Promise.resolve();

    // The race: a cancel followed by a start, both serviced BEFORE the
    // in-flight run's macrotask resolves.
    wrapper.cancel();
    const secondRun = wrapper.start();

    // The orchestrator's single-flight short-circuits the second start.
    await expect(secondRun).resolves.toMatchObject({ outcome: 'busy' });

    // The wrapper MUST have restored the cancel flag: a start that hit `busy`
    // did NOT begin a fresh run, so it must not de-arm the outstanding cancel
    // — the in-flight transport's next yield MUST still observe `true`.
    expect(port.probe()).toBe(true);

    // Clean up the outstanding first-run promise.
    port.release();
    await expect(firstRun).resolves.toMatchObject({ outcome: 'cancelled' });
  });

  it('clears the cancel flag on a fresh non-busy start (a completed run leaves the flag ready for the next run)', async () => {
    // Regression guard: the busy-restore MUST NOT apply when the underlying
    // start actually began a run. A completed non-cancelled run must leave the
    // flag cleared so a subsequent cycle observes a clean starting state.
    const port = fakePort();
    const wrapper = createCancelFlaggedCategorizationPort(port.build);

    const run = wrapper.start();
    await Promise.resolve();
    port.release(completedResult());
    await expect(run).resolves.toMatchObject({ outcome: 'completed' });

    expect(port.probe()).toBe(false);
  });
});
