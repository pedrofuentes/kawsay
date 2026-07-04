import { createWriteStream } from 'node:fs';
import { mkdir as mkdirFs, rename as renameFs, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  MODEL_DOWNLOAD_URL,
  MODEL_SHA256,
  MODEL_SIZE_BYTES,
} from './model-source';
import { hashFileSha256, verifyModelFile } from './model-integrity';

/**
 * The opt-in transcription model download manager (ADR-0027 Decision 6 / AC-17,
 * AC-24). It fetches the pinned `ggml-small.bin` ONCE, on a caller-initiated
 * opt-in, and only ever produces a checksum-verified, atomically-installed file.
 *
 * Transport — the load-bearing privacy fact: the fetch is issued through
 * **Electron's `net.request` on the GUARDED `session`** (injected here as
 * {@link ModelFetcher}), so it flows through `network-guard.ts`'s
 * `session.webRequest.onBeforeRequest` chokepoint. A Node `http`/`https`
 * downloader would BYPASS that guard entirely and is therefore never used (see
 * `electron-net-fetcher.ts` for the production adapter). This module stays pure +
 * injectable so the whole state machine (resume, progress, disk-full, single-
 * flight, skip, verify) is unit-tested without an Electron runtime.
 *
 * Guarantees:
 *  - **streamed** to a temp `.part` file (bounded memory for ~466 MiB);
 *  - **resumable** via HTTP Range — a dropped connection re-requests the pinned
 *    ORIGIN URL (never a cached signed CDN URL), so an expired signed redirect is
 *    transparently re-resolved on resume;
 *  - **progress** + typed terminal states reported via {@link ModelDownloadProgress};
 *  - **offline / disk-full / bad-status** surface a typed, calm
 *    {@link ModelDownloadError} (never a crash);
 *  - **bounded** — an idle-stall deadline aborts a connection that stops making
 *    forward progress — through an `AbortSignal`, so even a request still awaiting
 *    its response headers is released — so a stalled download can never sit
 *    non-terminal;
 *  - **single-flight** — concurrent calls coalesce to one download;
 *  - **skip** when a verified model already exists;
 *  - **atomic install** — verify the temp file's SHA-256 + size, then `rename()`
 *    into place; a mismatch is deleted and never installed.
 */

/** Terminal failure categories the caller can branch on (all calm, no crash). */
export type ModelDownloadErrorKind = 'network' | 'disk' | 'integrity' | 'http';

/** A typed, calm download failure. `retryable` tells the UI whether a retry may help. */
export class ModelDownloadError extends Error {
  readonly kind: ModelDownloadErrorKind;
  readonly retryable: boolean;
  constructor(
    kind: ModelDownloadErrorKind,
    message: string,
    options: { retryable: boolean; cause?: unknown } = { retryable: false },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ModelDownloadError';
    this.kind = kind;
    this.retryable = options.retryable;
  }
}

/** Lifecycle phase of a download, folded into a single progress stream. */
export type ModelDownloadPhase =
  | 'downloading'
  | 'verifying'
  | 'done'
  | 'already-present'
  | 'error';

/** One progress tick. Terminal phases (`done`/`already-present`/`error`) end the stream. */
export interface ModelDownloadProgress {
  readonly phase: ModelDownloadPhase;
  readonly bytesDownloaded: number;
  readonly totalBytes: number;
  readonly error: {
    readonly kind: ModelDownloadErrorKind;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
}

/** The request the downloader hands to the fetcher (always GET, always data-free). */
export interface ModelFetchRequest {
  readonly url: string;
  readonly method: 'GET';
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Optional pre-response abort handle. The idle-stall deadline can fire while the
   * fetch is still pending — the server accepted the socket but has sent NO
   * response headers — when no {@link ModelFetchResponse} (and thus no `cancel()`)
   * exists yet. Aborting this signal lets the adapter release the in-flight request
   * on that pre-headers path too (see `electron-net-fetcher.ts`). Optional so
   * existing callers/fetchers stay source-compatible.
   */
  readonly signal?: AbortSignal;
}

/** The fetcher's response — a status line plus a streamed body. The body is an
 *  `AsyncIterable<Uint8Array>`: Node's `http.IncomingMessage` satisfies it directly
 *  (it is an async-iterable Readable), whereas Electron's `net` `IncomingMessage` is a
 *  bare `EventEmitter` that `electron-net-fetcher.ts` bridges into this shape. */
export interface ModelFetchResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  /** Abort the in-flight response/socket (e.g. on an interruption or oversize). */
  cancel(): void;
}

/**
 * Issue ONE GET and return its streamed response. Production wires this to
 * Electron `net.request` on the guarded session (Chromium's stack, NOT Node
 * sockets), so the request passes through the `webRequest` allowlist.
 */
export type ModelFetcher = (request: ModelFetchRequest) => Promise<ModelFetchResponse>;

/**
 * Schedule the idle-stall deadline and return a canceller. Given a delay (ms) and
 * a callback, it arranges for the callback to run once after the delay and returns
 * a function that cancels it. Injectable so tests drive the deadline
 * deterministically (a captured callback fired on demand) instead of on the wall
 * clock. Production defaults to an unref'd `setTimeout`.
 */
export type StallTimeoutScheduler = (ms: number, onStall: () => void) => () => void;

/** A write sink for the temp `.part` file (production: `fs.createWriteStream`). */
export interface ModelWriteSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export type ModelWriteSinkFactory = (
  path: string,
  options: { append: boolean },
) => ModelWriteSink;

export interface ModelDownloadResult {
  readonly status: 'done' | 'already-present';
  readonly path: string;
}

export interface ModelDownloaderOptions {
  /** The guarded-session fetcher (Electron `net.request`); see {@link ModelFetcher}. */
  fetcher: ModelFetcher;
  /** Final on-disk path of the verified model (e.g. `userData/models/ggml-small.bin`). */
  modelPath: string;
  /** Temp file partial bytes accumulate in; defaults to `${modelPath}.part`. */
  partPath?: string;
  /** Pinned origin URL to fetch; defaults to the ADR-0027 pinned URL. */
  sourceUrl?: string;
  /** Pinned expected SHA-256; defaults to the ADR-0027 value. */
  expectedSha256?: string;
  /** Pinned expected byte size; defaults to the ADR-0027 value. */
  expectedSize?: number;
  /** Progress/terminal-state sink (the IPC layer forwards these to the renderer). */
  onProgress?: (progress: ModelDownloadProgress) => void;
  /** Temp-file write sink factory (injectable to simulate disk-full). */
  sink?: ModelWriteSinkFactory;
  /** File hasher (injectable); defaults to a streaming SHA-256. */
  hashFile?: (path: string) => Promise<string>;
  /**
   * Install-directory creator (injectable to simulate a commit-step failure).
   * Defaults to a recursive `fs.mkdir`. A failure here emits a terminal `error`.
   */
  mkdir?: (dir: string) => Promise<void>;
  /**
   * Atomic install rename (injectable to simulate a commit-step failure).
   * Defaults to `fs.rename`. A failure here emits a terminal `error`.
   */
  rename?: (from: string, to: string) => Promise<void>;
  /** Max HTTP attempts before a network failure becomes terminal (default 5). */
  maxAttempts?: number;
  /** Backoff sleeper (injectable for fast tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Backoff schedule (ms) for attempt N (1-based). */
  backoffMs?: (attempt: number) => number;
  /**
   * Idle-stall deadline (ms): abort a download that makes NO forward progress —
   * no byte written — within this window. A stalled connection (opens, delivers
   * nothing, and never ends) would otherwise sit non-terminal until app restart
   * (#242 🟢 2). The timer re-arms on every byte written, so a healthy — even
   * slow — download is never cut off. Defaults to {@link DEFAULT_STALL_TIMEOUT_MS}.
   */
  stallTimeoutMs?: number;
  /** Idle-stall deadline scheduler (injectable for deterministic tests); see
   *  {@link StallTimeoutScheduler}. Defaults to an unref'd `setTimeout`. */
  scheduleStallTimeout?: StallTimeoutScheduler;
}

export interface ModelDownloader {
  /** Download (or confirm) the verified model. Single-flight: concurrent calls coalesce. */
  downloadModel(): Promise<ModelDownloadResult>;
  /** True iff the model is present AND verified (a capability gate for the UI). */
  isModelReady(): Promise<boolean>;
  /** Whether a download is currently in flight. */
  isDownloading(): boolean;
}

const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Default idle-stall deadline: 60s without a single byte written aborts the
 * attempt. Generous enough that connect + TLS + redirect resolution + first byte
 * on a slow link never trips it, yet bounded so a truly stalled connection can't
 * sit non-terminal. Re-armed on every byte, so a slow-but-progressing download is
 * never cut off.
 */
const DEFAULT_STALL_TIMEOUT_MS = 60_000;

/** Node fs error codes that mean "the disk write failed" (not a network problem). */
const DISK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOSPC',
  'EDQUOT',
  'EROFS',
  'EFBIG',
  'EIO',
  'EACCES',
  'EPERM',
  'EMFILE',
  'ENFILE',
]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

const defaultScheduleStallTimeout: StallTimeoutScheduler = (ms, onStall) => {
  const timer = setTimeout(onStall, ms);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
  };
};

function defaultBackoff(attempt: number): number {
  // 0.5s, 1s, 2s, 4s … capped at 15s — gentle, calm, never a tight retry loop.
  return Math.min(15_000, 500 * 2 ** (attempt - 1));
}

/** A backpressure-aware write sink over `fs.createWriteStream`. */
const defaultSinkFactory: ModelWriteSinkFactory = (path, { append }) => {
  const stream = createWriteStream(path, { flags: append ? 'a' : 'w' });
  let failure: Error | undefined;
  stream.on('error', (err: Error) => {
    failure = err;
  });
  return {
    write(buffer: Uint8Array): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (failure) {
          reject(failure);
          return;
        }
        stream.write(buffer, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        stream.end(() => {
          if (failure) reject(failure);
          else resolve();
        });
      });
    },
    abort(): Promise<void> {
      return new Promise<void>((resolve) => {
        stream.destroy();
        resolve();
      });
    },
  };
};

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

function classifyStreamError(err: unknown): ModelDownloadError {
  if (err instanceof ModelDownloadError) {
    return err;
  }
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && DISK_ERROR_CODES.has(code)) {
    return new ModelDownloadError('disk', `writing the model failed (${code})`, {
      retryable: true,
      cause: err,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ModelDownloadError('network', `connection interrupted: ${message}`, {
    retryable: true,
    cause: err,
  });
}

/** Node fs error codes at the install-commit step that a later retry could clear. */
const INSTALL_RETRYABLE_CODES: ReadonlySet<string> = new Set(['ENOSPC', 'EDQUOT', 'EIO']);

/**
 * Classify a failure of the install commit — the install-dir `mkdir` or the atomic
 * `rename` — into a typed, TERMINAL `disk` error. These steps run OUTSIDE the
 * stream loop, so without this they would reject `run()` with NO terminal `error`
 * progress event; the fire-and-forget IPC handler's `.catch()` would then swallow
 * the failure and the renderer could hang at `verifying`. Out-of-space / I/O codes
 * are marked retryable; permission / cross-device / read-only failures are not.
 */
function classifyInstallError(err: unknown): ModelDownloadError {
  if (err instanceof ModelDownloadError) {
    return err;
  }
  const code = (err as { code?: unknown } | null)?.code;
  const detail = typeof code === 'string' ? ` (${code})` : '';
  const retryable = typeof code === 'string' && INSTALL_RETRYABLE_CODES.has(code);
  return new ModelDownloadError('disk', `installing the model failed${detail}`, {
    retryable,
    cause: err,
  });
}

export function createModelDownloader(options: ModelDownloaderOptions): ModelDownloader {
  const {
    fetcher,
    modelPath,
    partPath = `${modelPath}.part`,
    sourceUrl = MODEL_DOWNLOAD_URL,
    expectedSha256 = MODEL_SHA256,
    expectedSize = MODEL_SIZE_BYTES,
    onProgress,
    sink = defaultSinkFactory,
    hashFile = hashFileSha256,
    mkdir: mkdirInstallDir = (dir: string): Promise<void> =>
      mkdirFs(dir, { recursive: true }).then(() => undefined),
    rename: renameInto = renameFs,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    sleep = defaultSleep,
    backoffMs = defaultBackoff,
    stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
    scheduleStallTimeout = defaultScheduleStallTimeout,
  } = options;

  let active: Promise<ModelDownloadResult> | undefined;
  // In-memory session cache: the UI-facing readiness signal. The AUTHORITATIVE
  // anti-tamper guard is the standalone `verifyModelOnDisk()` re-run before each
  // `whisper-cli` spawn (AC-24) — never this cache.
  let verifiedThisSession = false;

  function emit(progress: ModelDownloadProgress): void {
    onProgress?.(progress);
  }

  async function verify(path: string): Promise<boolean> {
    const result = await verifyModelFile(
      path,
      { sha256: expectedSha256, size: expectedSize },
      { hashFile },
    );
    return result.valid;
  }

  async function isModelReady(): Promise<boolean> {
    if (verifiedThisSession) return true;
    const ready = await verify(modelPath);
    if (ready) verifiedThisSession = true;
    return ready;
  }

  async function run(): Promise<ModelDownloadResult> {
    // The byte count reflected in every progress tick for THIS run.
    let bytesDownloaded = 0;

    const fail = (error: ModelDownloadError): never => {
      emit({
        phase: 'error',
        bytesDownloaded,
        totalBytes: expectedSize,
        error: { kind: error.kind, message: error.message, retryable: error.retryable },
      });
      throw error;
    };

    /**
     * Issue one GET (with a Range header when resuming) and stream the body into
     * the temp file. Returns the new on-disk byte count. Throws a classified
     * {@link ModelDownloadError} on any HTTP/stream/disk problem.
     */
    const streamOnce = async (requestedOffset: number): Promise<number> => {
      const headers: Record<string, string> = {};
      if (requestedOffset > 0) {
        headers.Range = `bytes=${requestedOffset}-`;
      }

      // Bounded idle-stall deadline. A connection that opens but then delivers no
      // bytes (and never ends) must not sit non-terminal. The timer is armed
      // before the fetch and re-armed on every byte written; on expiry it rejects
      // THIS attempt with a TERMINAL network error FIRST — so the terminal error
      // wins the stall race — then aborts the in-flight request through
      // `abortController` so a request still awaiting its response headers (where
      // `res` is undefined and `res.cancel()` is a no-op) is released too, and via
      // `res.cancel()` once a response exists. The terminal rejection unwinds run()
      // and clears the single-flight lock so a later call starts fresh.
      let res: ModelFetchResponse | undefined;
      let cancelStall: (() => void) | undefined;
      let rejectStalled: ((error: ModelDownloadError) => void) | undefined;
      // Pre-response abort handle: the ONLY lever that can release a request which
      // has not yet produced a response (`res` still undefined) when the stall
      // fires. The adapter maps this to `net.request.abort()` (pre- and post-headers).
      const abortController = new AbortController();
      const stallSignal = new Promise<never>((_resolve, reject) => {
        rejectStalled = reject;
      });
      // A late stall firing after the attempt settles must never be an unhandled
      // rejection: keep an idle handler on the signal itself.
      void stallSignal.catch(() => undefined);

      const armStall = (): void => {
        cancelStall?.();
        cancelStall = scheduleStallTimeout(stallTimeoutMs, () => {
          // Reject the stall race with the TERMINAL error FIRST. Aborting the request
          // synchronously drives the fetcher's abort seam to reject the in-flight fetch
          // with a PLAIN Error; were that plain rejection to reach `raceStall` before
          // this terminal one, Promise.race would surface it and the outer loop would
          // reclassify it as retryable and retry a condition that must stay terminal
          // (#262/#296). Settling the terminal error first makes it win the race.
          rejectStalled?.(
            new ModelDownloadError(
              'network',
              `download stalled: no data received for ${String(stallTimeoutMs)}ms`,
              { retryable: false },
            ),
          );
          // Now release the underlying request. Pre-response this abort is the ONLY
          // effective lever (res is still undefined, so res?.cancel() is a no-op) and
          // still releases the socket both before and after headers (#274); once a
          // response exists res.cancel() additionally tears down the streamed body.
          // raceStall() swallows the resulting late plain-Error rejection.
          abortController.abort();
          res?.cancel();
        });
      };

      // Race a pending step against the stall deadline. The stall callback settles the
      // terminal error BEFORE aborting, so on a stall the terminal error wins this race;
      // swallow the step's own late, abort-driven rejection so it never surfaces as
      // unhandled.
      const raceStall = <T>(step: Promise<T>): Promise<T> => {
        void step.catch(() => undefined);
        return Promise.race([step, stallSignal]);
      };

      armStall();
      try {
        res = await raceStall(
          fetcher({ url: sourceUrl, method: 'GET', headers, signal: abortController.signal }),
        );
        const code = res.statusCode;

        if (code === 416) {
          // Range Not Satisfiable: our offset is at/after EOF. If the partial is
          // already complete, accept it; otherwise it is bogus — discard + restart.
          res.cancel();
          const size = (await sizeOf(partPath)) ?? 0;
          if (size >= expectedSize) {
            bytesDownloaded = size;
            return size;
          }
          await rm(partPath, { force: true });
          throw new ModelDownloadError('http', 'range not satisfiable (HTTP 416)', {
            retryable: true,
          });
        }
        if (code !== 200 && code !== 206) {
          res.cancel();
          const retryable = code >= 500 || code === 429 || code === 408;
          throw new ModelDownloadError('http', `unexpected HTTP status ${String(code)}`, {
            retryable,
          });
        }

        // Append only when we asked to resume AND the server honoured it (206).
        // A 200 to a ranged request means the server ignored the Range, so restart.
        const append = requestedOffset > 0 && code === 206;
        let written = append ? requestedOffset : 0;
        bytesDownloaded = written;
        const writer = sink(partPath, { append });
        try {
          // Consume via `for await` (no computed `[Symbol.asyncIterator]()` call —
          // SAST-clean), racing the WHOLE consumption loop against the idle-stall
          // deadline; `armStall()` re-arms the deadline on every byte written.
          const consume = (async (): Promise<void> => {
            for await (const piece of res.body) {
              if (written + piece.length > expectedSize) {
                // The stream delivered more than the pinned size — refuse it outright.
                throw new ModelDownloadError('integrity', 'stream exceeds expected model size', {
                  retryable: true,
                });
              }
              // Scope note (#276a): there is deliberately NO dedicated disk-write
              // deadline. The idle-stall deadline is a NETWORK-idleness guard,
              // re-armed on each write COMPLETION; because raceStall() wraps the
              // whole loop, a write that hangs is only *incidentally* bounded by it
              // and surfaces as a `network` stall. A first-class disk-write timeout
              // is intentionally out of scope for this network-idle deadline.
              await writer.write(piece);
              written += piece.length;
              bytesDownloaded = written;
              armStall(); // forward progress — reset the idle-stall deadline
              emit({ phase: 'downloading', bytesDownloaded: written, totalBytes: expectedSize, error: null });
            }
          })();
          await raceStall(consume);
          await writer.close();
          return written;
        } catch (err) {
          res.cancel();
          await writer.abort().catch(() => undefined);
          throw classifyStreamError(err);
        }
      } finally {
        cancelStall?.();
      }
    };

    // 1) Skip when a verified model is already installed (no network at all).
    if (await isModelReady()) {
      bytesDownloaded = expectedSize;
      emit({ phase: 'already-present', bytesDownloaded: expectedSize, totalBytes: expectedSize, error: null });
      return { status: 'already-present', path: modelPath };
    }

    // 2) Ensure the destination directory exists. A failure here (permissions,
    //    a file where the dir should be) is a terminal disk error, not a reject.
    try {
      await mkdirInstallDir(dirname(modelPath));
    } catch (err) {
      return fail(classifyInstallError(err));
    }

    // 3) Resume offset from any leftover .part (a corrupt over-long one is discarded).
    let offset = (await sizeOf(partPath)) ?? 0;
    if (offset > expectedSize) {
      await rm(partPath, { force: true });
      offset = 0;
    }
    bytesDownloaded = offset;
    emit({ phase: 'downloading', bytesDownloaded: offset, totalBytes: expectedSize, error: null });

    // 4) Attempt loop: stream, resuming on a network/HTTP hiccup until complete.
    //    The budget bounds CONSECUTIVE no-progress failures: any attempt that
    //    banked bytes (e.g. a bounded-buffer backpressure abort) resets it, so a
    //    healthy, steadily-resuming download is never starved of retries.
    let attempt = 0;
    while (offset < expectedSize) {
      attempt += 1;
      const offsetBefore = offset;
      try {
        offset = await streamOnce(offset);
      } catch (err) {
        const error = err instanceof ModelDownloadError ? err : classifyStreamError(err);
        if (error.kind === 'disk' || error.kind === 'integrity') {
          // The partial is unusable / the disk is full — clean up and stop.
          await rm(partPath, { force: true });
          return fail(error);
        }
        // Network/HTTP: keep the partial and resume from its true on-disk size.
        offset = (await sizeOf(partPath)) ?? 0;
        bytesDownloaded = offset;
        // Forward progress means the link is alive — reset the retry budget.
        if (offset > offsetBefore) {
          attempt = 0;
        }
        if (attempt < maxAttempts && error.retryable) {
          await sleep(backoffMs(attempt));
          emit({ phase: 'downloading', bytesDownloaded: offset, totalBytes: expectedSize, error: null });
          continue;
        }
        // Out of attempts: leave the .part so a later retry can still resume.
        return fail(error);
      }
    }

    // 5) Verify the completed temp file against the pinned integrity.
    emit({ phase: 'verifying', bytesDownloaded: expectedSize, totalBytes: expectedSize, error: null });
    if (!(await verify(partPath))) {
      // Never install an unverified file: delete it so a refetch starts clean.
      await rm(partPath, { force: true });
      return fail(
        new ModelDownloadError('integrity', 'downloaded model failed SHA-256 verification', {
          retryable: true,
        }),
      );
    }

    // 6) Atomic install: rename the verified temp file into place. A failure here
    //    (cross-device, permissions, disk-full at commit) is a terminal disk error
    //    — emit it so the renderer never hangs waiting past `verifying`.
    try {
      await renameInto(partPath, modelPath);
    } catch (err) {
      return fail(classifyInstallError(err));
    }
    verifiedThisSession = true;
    emit({ phase: 'done', bytesDownloaded: expectedSize, totalBytes: expectedSize, error: null });
    return { status: 'done', path: modelPath };
  }

  return {
    downloadModel(): Promise<ModelDownloadResult> {
      if (active) return active;
      // Fold the single-flight cleanup INTO the returned chain so there is no
      // dangling derived promise to surface as an unhandled rejection on failure.
      const pending = run().finally(() => {
        if (active === pending) active = undefined;
      });
      active = pending;
      return pending;
    },
    isModelReady,
    isDownloading(): boolean {
      return active !== undefined;
    },
  };
}
