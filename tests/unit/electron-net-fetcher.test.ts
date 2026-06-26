import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createElectronModelFetcher,
  type ElectronNetLike,
  type ElectronNetRequestOptions,
} from '../../electron/main/transcription/electron-net-fetcher';
import { createModelDownloader } from '../../electron/main/transcription/model-download';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

/** A fake Electron `ClientRequest`: an EventEmitter with the bits we drive. */
class FakeClientRequest extends EventEmitter {
  readonly headers: Record<string, string | string[]> = {};
  ended = false;
  aborted = false;
  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  end(): void {
    this.ended = true;
  }
  abort(): void {
    this.aborted = true;
    this.emit('abort');
  }
}

/** A fake Electron `IncomingMessage`: an EventEmitter carrying status + headers. */
class FakeIncomingMessage extends EventEmitter {
  constructor(
    readonly statusCode: number,
    readonly headers: Record<string, string | string[]>,
  ) {
    super();
  }
}

interface NetHarness {
  net: ElectronNetLike;
  request: FakeClientRequest;
  options(): ElectronNetRequestOptions;
}

function makeNet(): NetHarness {
  const request = new FakeClientRequest();
  let captured: ElectronNetRequestOptions | undefined;
  const net: ElectronNetLike = {
    request: vi.fn((options: ElectronNetRequestOptions) => {
      captured = options;
      return request as unknown as ReturnType<ElectronNetLike['request']>;
    }),
  };
  return {
    net,
    request,
    options: () => {
      if (captured === undefined) throw new Error('net.request was not called');
      return captured;
    },
  };
}

const SESSION = { id: 'guarded-session' };

describe('createElectronModelFetcher — routes through net.request on the guarded session', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('issues a GET on the guarded session, following redirects, with credentials omitted', async () => {
    const { net, request, options } = makeNet();
    const fetcher = createElectronModelFetcher(net, SESSION);

    const promise = fetcher({
      url: 'https://github.com/pedrofuentes/kawsay/releases/download/models-v1/ggml-small.bin',
      method: 'GET',
      headers: { Range: 'bytes=128-' },
    });

    // The request is configured for a privacy-preserving, redirect-following GET
    // bound to the GUARDED session — so it flows through the webRequest chokepoint.
    const opts = options();
    expect(opts.url).toBe(
      'https://github.com/pedrofuentes/kawsay/releases/download/models-v1/ggml-small.bin',
    );
    expect(opts.method).toBe('GET');
    expect(opts.session).toBe(SESSION);
    expect(opts.redirect).toBe('follow');
    expect(opts.credentials).toBe('omit');
    // The Range header is forwarded so a resume actually asks for the right bytes.
    expect(request.headers.Range).toBe('bytes=128-');
    expect(request.ended).toBe(true);

    const message = new FakeIncomingMessage(206, { 'content-range': 'bytes 128-130/300' });
    request.emit('response', message);
    const response = await promise;

    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe('bytes 128-130/300');

    const collected: number[] = [];
    const draining = (async () => {
      for await (const chunk of response.body) collected.push(...chunk);
    })();
    message.emit('data', Buffer.from([1, 2, 3]));
    message.emit('data', Buffer.from([4, 5]));
    message.emit('end');
    await draining;

    expect(collected).toEqual([1, 2, 3, 4, 5]);
  });

  it('cancel() aborts the underlying request', async () => {
    const { net, request } = makeNet();
    const fetcher = createElectronModelFetcher(net, SESSION);
    const promise = fetcher({ url: 'https://example/x', method: 'GET', headers: {} });
    request.emit('response', new FakeIncomingMessage(200, {}));
    const response = await promise;

    response.cancel();
    expect(request.aborted).toBe(true);
  });

  it('rejects when the request errors (offline / connection failure)', async () => {
    const { net, request } = makeNet();
    const fetcher = createElectronModelFetcher(net, SESSION);
    const promise = fetcher({ url: 'https://example/x', method: 'GET', headers: {} });
    request.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));

    await expect(promise).rejects.toThrow('net::ERR_INTERNET_DISCONNECTED');
  });

  it('surfaces a mid-stream error to the body consumer', async () => {
    const { net, request } = makeNet();
    const fetcher = createElectronModelFetcher(net, SESSION);
    const promise = fetcher({ url: 'https://example/x', method: 'GET', headers: {} });
    const message = new FakeIncomingMessage(200, {});
    request.emit('response', message);
    const response = await promise;

    const draining = (async () => {
      let received = 0;
      for await (const chunk of response.body) received += chunk.length;
      return received;
    })();
    message.emit('data', Buffer.from([9]));
    message.emit('error', new Error('net::ERR_CONNECTION_RESET'));

    await expect(draining).rejects.toThrow('net::ERR_CONNECTION_RESET');
  });

  it('rejects the body consumer when the connection is aborted mid-stream', async () => {
    const { net, request } = makeNet();
    const fetcher = createElectronModelFetcher(net, SESSION);
    const promise = fetcher({ url: 'https://example/x', method: 'GET', headers: {} });
    const message = new FakeIncomingMessage(200, {});
    request.emit('response', message);
    const response = await promise;

    const draining = (async () => {
      for await (const chunk of response.body) void chunk;
    })();
    message.emit('aborted');

    await expect(draining).rejects.toThrow(/aborted/i);
  });
});

describe('createElectronModelFetcher — bounded response buffer (backpressure)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('caps the in-memory queue: a producer outpacing the consumer stops at the high-water mark and aborts (resumable)', async () => {
    const { net, request } = makeNet();
    const cap = 8; // a tiny high-water mark (bytes) so the bound is easy to assert
    const fetcher = createElectronModelFetcher(net, SESSION, { maxBufferedBytes: cap });

    const promise = fetcher({ url: 'https://example/x', method: 'GET', headers: {} });
    const message = new FakeIncomingMessage(200, {});
    request.emit('response', message);
    const response = await promise;

    // Flood 20×4-byte chunks (80 bytes) BEFORE the consumer drains a single byte.
    // An unbounded queue would hold all 80 bytes in memory; the cap must not — on
    // a fast-net/slow-disk machine that runaway queue is the OOM risk being fixed.
    for (let i = 0; i < 20; i += 1) {
      message.emit('data', Buffer.from([i, i, i, i]));
    }
    message.emit('end');

    const received: number[] = [];
    const draining = (async () => {
      for await (const chunk of response.body) received.push(...chunk);
    })();

    // The consumer drains the bounded prefix, then sees the backpressure signal…
    await expect(draining).rejects.toThrow(/buffer|backpressure|high-water/i);
    // …memory stayed bounded: never more than the cap was queued/delivered…
    expect(received.length).toBeLessThanOrEqual(cap);
    // …and the request was aborted so the producer is told to stop (resume via Range).
    expect(request.aborted).toBe(true);
  });
});

describe('createElectronModelFetcher + createModelDownloader — bounded buffer completes via Range resume', () => {
  let dir: string;
  let modelPath: string;
  beforeEach(() => {
    dir = makeTmpDir('net-backpressure-');
    modelPath = join(dir, 'ggml-small.bin');
  });
  afterEach(() => {
    removeTmpDir(dir);
    vi.restoreAllMocks();
  });

  it('streams a fast producer / slow consumer to disk under the cap, resuming via Range, integrity intact', async () => {
    // A deterministic 64-byte "model" served in 4-byte chunks, flooded faster than
    // any consumer drains. With an 8-byte cap the fetcher must abort and the
    // downloader must resume via Range until the whole file lands, SHA-256 intact —
    // proving memory stays bounded without sacrificing a correct download.
    const payload = Buffer.from(Array.from({ length: 64 }, (_unused, i) => (i * 7 + 3) & 0xff));
    const payloadSha = createHash('sha256').update(payload).digest('hex');
    const cap = 8;
    const chunkSize = 4;

    const deliveredPerRequest: number[] = [];
    let calls = 0;
    const net: ElectronNetLike = {
      request: vi.fn(() => {
        calls += 1;
        const req = new FakeClientRequest();
        const idx = deliveredPerRequest.push(0) - 1;
        const realEnd = req.end.bind(req);
        // Emit only once end() is called, so the Range header (set via setHeader)
        // is already in place. Flood synchronously, halting the instant abort()
        // lands — exactly how a real socket stops delivering after an abort.
        req.end = () => {
          realEnd();
          const range = req.headers.Range as string | undefined;
          const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? '0') : 0;
          const message = new FakeIncomingMessage(start > 0 ? 206 : 200, {});
          req.emit('response', message);
          for (let i = start; i < payload.length; i += chunkSize) {
            if (req.aborted) break;
            const piece = payload.subarray(i, Math.min(i + chunkSize, payload.length));
            message.emit('data', Buffer.from(piece));
            deliveredPerRequest[idx] += piece.length;
          }
          if (!req.aborted) message.emit('end');
        };
        return req as unknown as ReturnType<ElectronNetLike['request']>;
      }),
    };

    const fetcher = createElectronModelFetcher(net, SESSION, { maxBufferedBytes: cap });
    const downloader = createModelDownloader({
      fetcher,
      modelPath,
      expectedSha256: payloadSha,
      expectedSize: payload.length,
      sleep: () => Promise.resolve(),
    });

    const result = await downloader.downloadModel();

    expect(result.status).toBe('done');
    // Integrity intact: the reassembled file is byte-for-byte the model.
    expect(readFileSync(modelPath)).toEqual(payload);
    // It genuinely resumed — more than one bounded request was needed…
    expect(calls).toBeGreaterThan(1);
    // …and no single request ever buffered more than the cap (+ the one chunk that
    // tripped it), so peak memory stayed bounded regardless of the body size.
    expect(Math.max(...deliveredPerRequest)).toBeLessThanOrEqual(cap + chunkSize);
  });
});
