import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createElectronModelFetcher,
  type ElectronNetLike,
  type ElectronNetRequestOptions,
} from '../../electron/main/transcription/electron-net-fetcher';

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
