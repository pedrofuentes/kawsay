import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createModelDownloader,
  ModelDownloadError,
  type ModelDownloadProgress,
  type ModelFetchRequest,
  type ModelFetchResponse,
  type ModelWriteSinkFactory,
} from '../../electron/main/transcription/model-download';
import { MODEL_DOWNLOAD_URL } from '../../electron/main/transcription/model-source';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A deterministic, tiny "model" payload split into fixed-size chunks. */
const MODEL_BYTES = Buffer.from('KAWSAY-MODEL-PAYLOAD-0123456789!!', 'utf8'); // 33 bytes
const MODEL_SHA = sha256(MODEL_BYTES);

function chunk(from: number, to: number): Uint8Array {
  return Uint8Array.prototype.slice.call(MODEL_BYTES, from, to);
}

/** An async body that yields the given chunks, optionally throwing after `failAfter`. */
async function* bytesBody(
  chunks: readonly Uint8Array[],
  failAfter?: number,
): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < chunks.length; i += 1) {
    if (failAfter !== undefined && i === failAfter) {
      throw new Error('net::ERR_CONNECTION_RESET');
    }
    yield chunks[i];
  }
  if (failAfter !== undefined && failAfter >= chunks.length) {
    throw new Error('net::ERR_CONNECTION_RESET');
  }
}

function response(
  statusCode: number,
  body: AsyncIterable<Uint8Array>,
  headers: Record<string, string | string[]> = {},
): ModelFetchResponse {
  return { statusCode, headers, body, cancel: vi.fn() };
}

interface FetcherHarness {
  fetcher: (req: ModelFetchRequest) => Promise<ModelFetchResponse>;
  requests: ModelFetchRequest[];
}

function makeFetcher(
  handler: (req: ModelFetchRequest, call: number) => ModelFetchResponse | Promise<ModelFetchResponse>,
): FetcherHarness {
  const requests: ModelFetchRequest[] = [];
  let call = 0;
  const fetcher = async (req: ModelFetchRequest): Promise<ModelFetchResponse> => {
    requests.push(req);
    const current = call;
    call += 1;
    return handler(req, current);
  };
  return { fetcher, requests };
}

describe('createModelDownloader — happy path, progress, atomic install', () => {
  let dir: string;
  let modelPath: string;
  let progress: ModelDownloadProgress[];

  beforeEach(() => {
    dir = makeTmpDir('model-dl-');
    modelPath = join(dir, 'models', 'ggml-small.bin');
    progress = [];
  });
  afterEach(() => {
    removeTmpDir(dir);
  });

  it('streams to a temp file, verifies, renames into place, and reports progress', async () => {
    const { fetcher, requests } = makeFetcher(() =>
      response(200, bytesBody([chunk(0, 11), chunk(11, 22), chunk(22, 33)])),
    );
    const downloader = createModelDownloader({
      fetcher,
      modelPath,
      expectedSha256: MODEL_SHA,
      expectedSize: MODEL_BYTES.length,
      onProgress: (p) => progress.push(p),
    });

    const result = await downloader.downloadModel();

    expect(result).toEqual({ status: 'done', path: modelPath });
    // The verified model is installed; the temp .part is gone (atomic rename).
    expect(readFileSync(modelPath)).toEqual(MODEL_BYTES);
    expect(existsSync(`${modelPath}.part`)).toBe(false);

    // The fetch targets the pinned origin URL, GET, with no Range on a fresh start.
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(MODEL_DOWNLOAD_URL);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].headers.Range).toBeUndefined();

    // Progress is monotonic up to the total, includes a verify tick, ends done.
    const phases = progress.map((p) => p.phase);
    expect(phases[0]).toBe('downloading');
    expect(phases).toContain('verifying');
    expect(phases.at(-1)).toBe('done');
    expect(progress.every((p) => p.totalBytes === MODEL_BYTES.length)).toBe(true);
    const bytes = progress.filter((p) => p.phase === 'downloading').map((p) => p.bytesDownloaded);
    expect(bytes).toEqual([...bytes].sort((a, b) => a - b));
    expect(progress.at(-1)?.bytesDownloaded).toBe(MODEL_BYTES.length);
  });
});

describe('createModelDownloader — resumable download (HTTP Range)', () => {
  let dir: string;
  let modelPath: string;
  beforeEach(() => {
    dir = makeTmpDir('model-dl-resume-');
    modelPath = join(dir, 'ggml-small.bin');
  });
  afterEach(() => {
    removeTmpDir(dir);
  });

  it('resumes from the byte offset after a mid-stream interruption, re-requesting the pinned origin', async () => {
    const { fetcher, requests } = makeFetcher((_req, call) => {
      if (call === 0) {
        // First attempt: deliver 16 bytes, then the connection drops.
        return response(200, bytesBody([chunk(0, 16)], 1));
      }
      // Resume: server honours the Range with a 206 and the remaining bytes.
      return response(206, bytesBody([chunk(16, 33)]), {
        'content-range': `bytes 16-32/${String(MODEL_BYTES.length)}`,
      });
    });
    const downloader = createModelDownloader({
      fetcher,
      modelPath,
      expectedSha256: MODEL_SHA,
      expectedSize: MODEL_BYTES.length,
      maxAttempts: 3,
      sleep: () => Promise.resolve(),
    });

    const result = await downloader.downloadModel();

    expect(result.status).toBe('done');
    expect(readFileSync(modelPath)).toEqual(MODEL_BYTES);
    // Exactly two requests; the resume carried the byte-range header…
    expect(requests).toHaveLength(2);
    expect(requests[1].headers.Range).toBe('bytes=16-');
    // …and BOTH legs re-request the pinned origin URL (never a cached signed CDN
    // URL), so an expired signed redirect is always re-resolved on resume.
    expect(requests.every((r) => r.url === MODEL_DOWNLOAD_URL)).toBe(true);
  });

  it('resumes from an existing .part left by a previous run (cross-restart resume)', async () => {
    writeFileSync(`${modelPath}.part`, Buffer.from(chunk(0, 10)));
    const { fetcher, requests } = makeFetcher(() =>
      response(206, bytesBody([chunk(10, 33)]), {
        'content-range': `bytes 10-32/${String(MODEL_BYTES.length)}`,
      }),
    );
    const downloader = createModelDownloader({
      fetcher,
      modelPath,
      expectedSha256: MODEL_SHA,
      expectedSize: MODEL_BYTES.length,
    });

    const result = await downloader.downloadModel();
    expect(result.status).toBe('done');
    expect(readFileSync(modelPath)).toEqual(MODEL_BYTES);
    expect(requests[0].headers.Range).toBe('bytes=10-');
  });

  it('restarts from zero when the server ignores Range and replies 200', async () => {
    // A stale partial from a prior, different attempt.
    writeFileSync(`${modelPath}.part`, Buffer.from('STALE-GARBAGE'));
    const { fetcher, requests } = makeFetcher(() =>
      response(200, bytesBody([chunk(0, 33)])),
    );
    const downloader = createModelDownloader({
      fetcher,
      modelPath,
      expectedSha256: MODEL_SHA,
      expectedSize: MODEL_BYTES.length,
    });

    const result = await downloader.downloadModel();
    expect(result.status).toBe('done');
    // The stale prefix was discarded — the file is exactly the model, not garbage+body.
    expect(readFileSync(modelPath)).toEqual(MODEL_BYTES);
    expect(requests[0].headers.Range).toBe('bytes=13-');
  });

  it('discards a stale partial on HTTP 416 (range not satisfiable) and cleanly restarts', async () => {
    // A leftover .part whose offset the server now rejects (the asset changed, or
    // the partial is bogus). The first ranged request gets 416; the partial must be
    // discarded and the download must restart from zero and complete — not wedge.
    writeFileSync(`${modelPath}.part`, Buffer.from(chunk(0, 20)));
    const { fetcher, requests } = makeFetcher((req) =>
      req.headers.Range !== undefined
        ? response(416, bytesBody([]))
        : response(200, bytesBody([chunk(0, 33)])),
    );
    const downloader = createModelDownloader({
      fetcher,
      modelPath,
      expectedSha256: MODEL_SHA,
      expectedSize: MODEL_BYTES.length,
      maxAttempts: 3,
      sleep: () => Promise.resolve(),
    });

    const result = await downloader.downloadModel();
    expect(result.status).toBe('done');
    expect(readFileSync(modelPath)).toEqual(MODEL_BYTES);
    // First request carried the stale Range and got 416; the retry restarted clean.
    expect(requests[0].headers.Range).toBe('bytes=20-');
    expect(requests[1].headers.Range).toBeUndefined();
    expect(existsSync(`${modelPath}.part`)).toBe(false);
  });
});

describe('createModelDownloader — typed, calm failures (no crash)', () => {
  let dir: string;
  let modelPath: string;
  let progress: ModelDownloadProgress[];
  beforeEach(() => {
    dir = makeTmpDir('model-dl-fail-');
    modelPath = join(dir, 'ggml-small.bin');
    progress = [];
  });
  afterEach(() => {
    removeTmpDir(dir);
  });

  it('offline / network error → typed retryable ModelDownloadError, no file left', async () => {
    const { fetcher } = makeFetcher(() =>
      Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')),
    );
    const downloader = createModelDownloader({
      fetcher,
      modelPath,
      expectedSha256: MODEL_SHA,
      expectedSize: MODEL_BYTES.length,
      maxAttempts: 2,
      sleep: () => Promise.resolve(),
      onProgress: (p) => progress.push(p),
    });

    const error = await downloader.downloadModel().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelDownloadError);
    expect((error as ModelDownloadError).kind).toBe('network');
    expect((error as ModelDownloadError).retryable).toBe(true);
    expect(existsSync(modelPath)).toBe(false);
    expect(progress.at(-1)?.phase).toBe('error');
    expect(progress.at(-1)?.error?.kind).toBe('network');
  });

  it('disk-full mid-write → typed disk ModelDownloadError, temp cleaned up', async () => {
    const diskFullSink: ModelWriteSinkFactory = () => ({
      write: () =>
        Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })),
      close: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    });
    const { fetcher } = makeFetcher(() => response(200, bytesBody([chunk(0, 33)])));
    const downloader = createModelDownloader({
      fetcher,
      modelPath,
      expectedSha256: MODEL_SHA,
      expectedSize: MODEL_BYTES.length,
      sink: diskFullSink,
      onProgress: (p) => progress.push(p),
    });

    const error = await downloader.downloadModel().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelDownloadError);
    expect((error as ModelDownloadError).kind).toBe('disk');
    expect(existsSync(`${modelPath}.part`)).toBe(false);
    expect(existsSync(modelPath)).toBe(false);
    expect(progress.at(-1)?.error?.kind).toBe('disk');
  });

  it('a downloaded file whose hash does NOT match is rejected, deleted, and never installed', async () => {
    const wrong = Buffer.from('this is the wrong payload entirely!!', 'utf8');
    const { fetcher } = makeFetcher(() => response(200, bytesBody([wrong])));
    const downloader = createModelDownloader({
      fetcher,
      modelPath,
      // Expect the REAL model's hash/size-by-length, but the server returns junk.
      expectedSha256: MODEL_SHA,
      expectedSize: wrong.length, // size matches so the hash gate is what fails
      onProgress: (p) => progress.push(p),
    });

    const error = await downloader.downloadModel().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelDownloadError);
    expect((error as ModelDownloadError).kind).toBe('integrity');
    expect((error as ModelDownloadError).retryable).toBe(true);
    // Never install an unverified file; the temp is removed so a refetch is clean.
    expect(existsSync(modelPath)).toBe(false);
    expect(existsSync(`${modelPath}.part`)).toBe(false);
    expect(progress.at(-1)?.error?.kind).toBe('integrity');
  });

  it('an unexpected HTTP status (404) → typed http error', async () => {
    const { fetcher } = makeFetcher(() => response(404, bytesBody([])));
    const downloader = createModelDownloader({
      fetcher,
      modelPath,
      expectedSha256: MODEL_SHA,
      expectedSize: MODEL_BYTES.length,
      maxAttempts: 1,
      sleep: () => Promise.resolve(),
    });
    const error = await downloader.downloadModel().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelDownloadError);
    expect((error as ModelDownloadError).kind).toBe('http');
  });
});

describe('createModelDownloader — single-flight & skip-when-present', () => {
  let dir: string;
  let modelPath: string;
  beforeEach(() => {
    dir = makeTmpDir('model-dl-flight-');
    modelPath = join(dir, 'ggml-small.bin');
  });
  afterEach(() => {
    removeTmpDir(dir);
  });

  it('coalesces concurrent downloadModel() calls into ONE download (single-flight lock)', async () => {
    const { fetcher, requests } = makeFetcher(() => response(200, bytesBody([chunk(0, 33)])));
    const downloader = createModelDownloader({
      fetcher,
      modelPath,
      expectedSha256: MODEL_SHA,
      expectedSize: MODEL_BYTES.length,
    });

    const [a, b] = await Promise.all([downloader.downloadModel(), downloader.downloadModel()]);
    expect(a).toEqual(b);
    expect(requests).toHaveLength(1);
  });

  it('skips the download when a verified model is already present', async () => {
    writeFileSync(modelPath, MODEL_BYTES);
    const { fetcher, requests } = makeFetcher(() => response(200, bytesBody([chunk(0, 33)])));
    const progress: ModelDownloadProgress[] = [];
    const downloader = createModelDownloader({
      fetcher,
      modelPath,
      expectedSha256: MODEL_SHA,
      expectedSize: MODEL_BYTES.length,
      onProgress: (p) => progress.push(p),
    });

    const result = await downloader.downloadModel();
    expect(result.status).toBe('already-present');
    expect(requests).toHaveLength(0); // no network at all
    expect(progress.at(-1)?.phase).toBe('already-present');
  });

  it('isModelReady reflects presence + verification', async () => {
    const { fetcher } = makeFetcher(() => response(200, bytesBody([chunk(0, 33)])));
    const downloader = createModelDownloader({
      fetcher,
      modelPath,
      expectedSha256: MODEL_SHA,
      expectedSize: MODEL_BYTES.length,
    });
    expect(await downloader.isModelReady()).toBe(false);
    await downloader.downloadModel();
    expect(await downloader.isModelReady()).toBe(true);
  });
});

describe('createModelDownloader — progress-driven resume budget (bounded-buffer backpressure)', () => {
  let dir: string;
  let modelPath: string;
  beforeEach(() => {
    dir = makeTmpDir('model-dl-budget-');
    modelPath = join(dir, 'ggml-small.bin');
  });
  afterEach(() => {
    removeTmpDir(dir);
  });

  it('keeps resuming while each attempt makes forward progress, even past maxAttempts interruptions', async () => {
    // Every attempt delivers ONE byte then drops the connection — the shape a
    // bounded-buffer backpressure abort produces on a slow disk. With a blunt
    // 2-attempt budget this would die after 2 bytes; because each attempt makes
    // forward progress the budget must reset so the whole file still lands.
    const { fetcher, requests } = makeFetcher((req) => {
      const range = req.headers.Range;
      const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? '0') : 0;
      const end = Math.min(start + 1, MODEL_BYTES.length);
      const status = start > 0 ? 206 : 200;
      const headers: Record<string, string> =
        start > 0 ? { 'content-range': `bytes ${start}-${end - 1}/${MODEL_BYTES.length}` } : {};
      // Drop right after the single byte unless this is the final byte (then finish).
      const failAfter = end < MODEL_BYTES.length ? 1 : undefined;
      return response(status, bytesBody([chunk(start, end)], failAfter), headers);
    });
    const downloader = createModelDownloader({
      fetcher,
      modelPath,
      expectedSha256: MODEL_SHA,
      expectedSize: MODEL_BYTES.length,
      maxAttempts: 2,
      sleep: () => Promise.resolve(),
    });

    const result = await downloader.downloadModel();

    expect(result.status).toBe('done');
    expect(readFileSync(modelPath)).toEqual(MODEL_BYTES);
    // It took far more than the 2-attempt budget — proof the budget resets on
    // progress rather than capping a healthy, steadily-resuming download.
    expect(requests.length).toBeGreaterThan(2);
  });
});

describe('createModelDownloader — install-commit failures emit a terminal error (no silent reject)', () => {
  let dir: string;
  let modelPath: string;
  let progress: ModelDownloadProgress[];
  beforeEach(() => {
    dir = makeTmpDir('model-dl-commit-');
    modelPath = join(dir, 'models', 'ggml-small.bin');
    progress = [];
  });
  afterEach(() => {
    removeTmpDir(dir);
  });

  it('emits a terminal error progress event when the atomic install rename fails', async () => {
    const renameError = Object.assign(new Error('EXDEV: cross-device link not permitted'), {
      code: 'EXDEV',
    });
    const { fetcher } = makeFetcher(() => response(200, bytesBody([chunk(0, 33)])));
    const downloader = createModelDownloader({
      fetcher,
      modelPath,
      expectedSha256: MODEL_SHA,
      expectedSize: MODEL_BYTES.length,
      rename: () => Promise.reject(renameError),
      onProgress: (p) => progress.push(p),
    });

    const error = await downloader.downloadModel().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ModelDownloadError);
    expect((error as ModelDownloadError).kind).toBe('disk');
    // The crux: a TERMINAL error progress event is emitted, so the IPC handler's
    // fire-and-forget `.catch()` cannot swallow the failure into a renderer that
    // hangs forever at `verifying`.
    expect(progress.at(-1)?.phase).toBe('error');
    expect(progress.at(-1)?.error?.kind).toBe('disk');
  });

  it('emits a terminal error progress event when creating the install directory fails', async () => {
    const mkdirError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const { fetcher } = makeFetcher(() => response(200, bytesBody([chunk(0, 33)])));
    const downloader = createModelDownloader({
      fetcher,
      modelPath,
      expectedSha256: MODEL_SHA,
      expectedSize: MODEL_BYTES.length,
      mkdir: () => Promise.reject(mkdirError),
      onProgress: (p) => progress.push(p),
    });

    const error = await downloader.downloadModel().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ModelDownloadError);
    expect((error as ModelDownloadError).kind).toBe('disk');
    expect(progress.at(-1)?.phase).toBe('error');
    expect(progress.at(-1)?.error?.kind).toBe('disk');
  });
});
