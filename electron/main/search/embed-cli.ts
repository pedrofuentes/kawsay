import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The on-device text-embedding seam for M4 smart search (ADR-0029 Decision 1,
// milestone M4-1b). It resolves the bundled llama.cpp `llama-embedding` binary and
// the bundled `multilingual-e5-small` GGUF, then turns a BATCH of texts into
// 384-dim, L2-normalized float vectors (cosine == dot product) — the vectors the
// embeddings repo + the FTS-merge (ADR-0029) consume in later slices.
//
// It deliberately MIRRORS the M2 subprocess seams it is analogous to:
//   • path resolution   → importers/deps/media-binaries.ts + transcription/whisper-cli.ts
//     (packaged via process.resourcesPath, dev via the repo resources/ tree),
//   • the bounded spawn  → transcription/transcribe.ts's defaultRunWhisper
//     (an ARRAY argv — never a shell string, local-file-only inputs, a hard
//     timeout that SIGKILLs an overrunning child, a cooperative cancel, bounded
//     stderr, and zero network).
//
// This slice is PURELY ADDITIVE: it adds this wrapper (and its tests) only. It does
// NOT touch the live search path and adds NO runtime dependency — the binary and
// model are bundled in the later packaging slice, so NEITHER exists yet. Until they
// do (dev, CI, and today), resolution returns null and {@link createEmbedder}
// yields a typed UNAVAILABLE result — NEVER a throw — so search falls back to exact
// FTS with byte-identical AC-7 results. The wrapper is fully injectable (spawn + the
// input writer), so it is unit-tested without a real binary.

/** Sub-directory (under the resources root) that holds the per-arch bundle. */
export const EMBED_RESOURCE_SUBDIR = 'embed';

/** The platform-independent stem of the executable (`.exe` is added on Windows). */
export const EMBED_CLI_BINARY_BASENAME = 'llama-embedding';

/**
 * The bundled GGUF filename, resolved ALONGSIDE the binary in the same
 * `<os>-<arch>` dir. A shipped GGUF MUST have `tokenizer.ggml.model == t5`
 * (SentencePiece) — that provenance/integrity assertion is a packaging/CI guard
 * (the later bundling slice), NOT this wrapper's job.
 */
export const EMBED_MODEL_FILENAME = 'multilingual-e5-small-q4_k_m.gguf';

/** The model's stable provenance id (the `model_id` a later slice stores per vector). */
export const EMBED_MODEL_ID = 'multilingual-e5-small';

/** The embedding dimensionality of `multilingual-e5-small` (validated by the spike). */
export const EMBED_DIM = 384;

/** e5 prefix for a SEARCH QUERY (the query/passage asymmetry e5 requires). */
export const QUERY_PREFIX = 'query: ';
/** e5 prefix for a STORED item (a "passage"). */
export const PASSAGE_PREFIX = 'passage: ';

/** Hard ceiling (ms) on a single `llama-embedding` invocation — a resource cap. */
export const EMBED_TIMEOUT_MS = 120_000;

/** Cap captured stderr so a chatty `llama-embedding` cannot balloon memory. */
export const EMBED_STDERR_CAP = 8192;

/**
 * The exact `<os>-<arch>` bundle sub-directories Kawsay ships for — identical to
 * whisper-cli's / media's shipped matrix (macOS arm64 + x64, Windows x64); the
 * three bundles travel together. Windows arm64 is deferred (ADR-0007).
 */
export const SUPPORTED_EMBED_TARGETS = ['mac-arm64', 'mac-x64', 'win-x64'] as const;

/** A `<os>-<arch>` directory Kawsay ships the embed bundle for. */
export type EmbedTarget = (typeof SUPPORTED_EMBED_TARGETS)[number];

/** The electron-builder `${os}` key (Platform.buildConfigurationKey) we ship for. */
export type EmbedOsKey = 'mac' | 'win';

/**
 * Map a Node `process.platform` to the electron-builder `${os}` key used in the
 * bundle path, or `null` for an unshipped platform. Unlike the throwing
 * whisper-cli / media-binaries siblings, this returns null: the whole wrapper
 * degrades to UNAVAILABLE (→ exact-FTS fallback) wherever it is not shipped — a
 * dev on Linux never crashes, they just get today's exact search.
 */
export function embedOsKey(platform: NodeJS.Platform): EmbedOsKey | null {
  switch (platform) {
    case 'darwin':
      return 'mac';
    case 'win32':
      return 'win';
    default:
      return null;
  }
}

/** The platform-specific executable name (`llama-embedding.exe` on Windows). */
export function embedCliBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${EMBED_CLI_BINARY_BASENAME}.exe` : EMBED_CLI_BINARY_BASENAME;
}

function isSupportedTarget(target: string): target is EmbedTarget {
  return (SUPPORTED_EMBED_TARGETS as readonly string[]).includes(target);
}

/**
 * The `<os>-<arch>` bundle sub-directory for a platform/arch, matching what
 * electron-builder's `${os}-${arch}` macro expands to — or `null` for any target
 * outside the shipped matrix (Windows arm64, a non-arm64/x64 arch, or an unshipped
 * platform). Non-throwing, so the resolvers stay total and degrade to UNAVAILABLE.
 */
export function embedArchDir(platform: NodeJS.Platform, arch: string): EmbedTarget | null {
  const os = embedOsKey(platform);
  if (os === null) return null;
  const target = `${os}-${arch}`;
  return isSupportedTarget(target) ? target : null;
}

/** Inputs for {@link resolveEmbedBinaryPath} / {@link resolveEmbedModelPath}. */
export interface ResolveEmbedFileOptions {
  /** Whether the app is packaged (`app.isPackaged`) — selects the base directory. */
  isPackaged: boolean;
  /** `process.resourcesPath` — the packaged app's resources dir (used when packaged). */
  resourcesPath: string;
  /** The app/repo root that contains the source `resources/` tree (used in dev). */
  projectRoot: string;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.arch`. */
  arch?: string;
  /** Existence probe (injected for tests); defaults to `fs.existsSync`. */
  exists?: (path: string) => boolean;
}

/**
 * Resolve the absolute path of a file inside the per-arch embed bundle, or `null`
 * when the platform/arch is unshipped OR the file is simply absent on disk.
 *
 * - **Packaged:** `<process.resourcesPath>/embed/<os>-<arch>/<filename>`.
 * - **Dev:** `<projectRoot>/resources/embed/<os>-<arch>/<filename>`.
 */
function resolveEmbedFile(filename: string, options: ResolveEmbedFileOptions): string | null {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const exists = options.exists ?? existsSync;

  const archDir = embedArchDir(platform, arch);
  if (archDir === null) return null;

  const base = options.isPackaged
    ? join(options.resourcesPath, EMBED_RESOURCE_SUBDIR, archDir)
    : join(options.projectRoot, 'resources', EMBED_RESOURCE_SUBDIR, archDir);
  const filePath = join(base, filename);

  return exists(filePath) ? filePath : null;
}

/** Resolve the bundled `llama-embedding` binary, or `null` when it is absent. */
export function resolveEmbedBinaryPath(options: ResolveEmbedFileOptions): string | null {
  const platform = options.platform ?? process.platform;
  return resolveEmbedFile(embedCliBinaryName(platform), options);
}

/** Resolve the bundled model GGUF (alongside the binary), or `null` when absent. */
export function resolveEmbedModelPath(options: ResolveEmbedFileOptions): string | null {
  return resolveEmbedFile(EMBED_MODEL_FILENAME, options);
}

// ── e5 prefixes + input-line sanitation ─────────────────────────────────────

/** Prepend the e5 `"query: "` prefix to a search query. */
export function withQueryPrefix(text: string): string {
  return `${QUERY_PREFIX}${text}`;
}

/** Prepend the e5 `"passage: "` prefix to a stored item. */
export function withPassagePrefix(text: string): string {
  return `${PASSAGE_PREFIX}${text}`;
}

/**
 * Flatten a single text to exactly one input line. `llama-embedding` splits its
 * `-f` file on `"\n"` (one prompt per line), so an embedded CR/LF in a caption or
 * description would otherwise become MULTIPLE prompts and desync the N-in / N-out
 * contract. Every newline run is collapsed to a single space (mean-pooled e5 is
 * insensitive to the whitespace), guaranteeing one embedding per text.
 */
export function toEmbeddingInputLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

/** Build the newline-delimited `-f` input for a batch: one sanitized line per text. */
export function buildEmbedInput(texts: readonly string[]): string {
  return texts.map(toEmbeddingInputLine).join('\n');
}

// ── Argv construction (array argv; validated flags; flag-injection guard) ────

/** A discrete argv element must never be empty or begin with `-` (a flag). */
function assertEmbedArg(value: string, label: string): void {
  if (value.length === 0 || value.startsWith('-')) {
    throw new Error(`buildEmbedArgs: refusing a ${label} that could be read as a flag: "${value}"`);
  }
}

/** Inputs for {@link buildEmbedArgs}. */
export interface BuildEmbedArgsOptions {
  /** Absolute LOCAL path of the resolved model GGUF. */
  modelPath: string;
  /** Absolute LOCAL path of the temp file holding one text per line. */
  inputPath: string;
}

/**
 * Build the spike-validated `llama-embedding` argv for a batch, emitting the JSON
 * embedding envelope. Pure, and crucially an ARRAY argv: the model + input file are
 * discrete elements, never concatenated into a flag or a shell string. The
 * UNTRUSTED texts never appear here — they live only in the `-f` file's CONTENT —
 * so a crafted caption can never inject a flag or shell syntax. `--pooling mean`
 * + `--embd-normalize 2` (L2) make cosine == dot product.
 */
export function buildEmbedArgs({ modelPath, inputPath }: BuildEmbedArgsOptions): string[] {
  assertEmbedArg(modelPath, 'model path');
  assertEmbedArg(inputPath, 'input path');
  return [
    '-m',
    modelPath,
    '-f',
    inputPath,
    '--embd-output-format',
    'json',
    '--pooling',
    'mean',
    '--embd-normalize',
    '2',
  ];
}

// ── JSON → Float32Array[] parsing ───────────────────────────────────────────

/** A typed failure parsing `llama-embedding`'s output (malformed / wrong shape / dim / count). */
export class EmbedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedParseError';
  }
}

/** One entry of the llama.cpp `--embd-output-format json` envelope. */
interface EmbeddingEnvelopeEntry {
  embedding?: unknown;
}
interface EmbeddingEnvelope {
  data?: unknown;
}

/**
 * Parse `stdout` (the JSON object llama.cpp emits) as raw float arrays. Accepts the
 * `{ data: [{ embedding: [...] }] }` envelope AND a bare `[[...]]` array (the
 * `array` output format), and is robust to stray log lines leaking around the JSON
 * (the object/array substring is extracted before parsing).
 */
function extractRawVectors(raw: string): number[][] {
  const parsed = parseJsonLoose(raw);
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as EmbeddingEnvelope).data)
      ? ((parsed as EmbeddingEnvelope).data as unknown[])
      : (() => {
          throw new EmbedParseError('embedding output is neither an array nor a { data } envelope');
        })();

  return rows.map((row) => {
    const candidate = Array.isArray(row) ? row : (row as EmbeddingEnvelopeEntry).embedding;
    if (!Array.isArray(candidate)) {
      throw new EmbedParseError('embedding entry has no numeric vector');
    }
    return candidate as number[];
  });
}

/** JSON.parse, tolerant of stray log noise around the object/array; typed on failure. */
function parseJsonLoose(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall back to the outermost {...} or [...] span if a stray line leaked to stdout.
    const start = trimmed.search(/[[{]/);
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // fall through to the typed error below
      }
    }
    throw new EmbedParseError('embedding output was not valid JSON');
  }
}

/**
 * Parse `llama-embedding`'s JSON `stdout` into exactly `expectedCount` vectors of
 * `dim` floats each. Throws {@link EmbedParseError} on malformed JSON, the wrong
 * count, a wrong-dimension vector, or a non-finite element — a broken embed is
 * never silently accepted (it must not reach the persistence layer, which guards
 * finiteness again). Every returned vector is a fresh {@link Float32Array}.
 */
export function parseEmbeddingJson(
  raw: string,
  expectedCount: number,
  dim: number = EMBED_DIM,
): Float32Array[] {
  const rawVectors = extractRawVectors(raw);
  if (rawVectors.length !== expectedCount) {
    throw new EmbedParseError(
      `expected ${String(expectedCount)} embeddings, got ${String(rawVectors.length)}`,
    );
  }
  return rawVectors.map((values, index) => {
    if (values.length !== dim) {
      throw new EmbedParseError(
        `embedding ${String(index)} has dimension ${String(values.length)}, expected ${String(dim)}`,
      );
    }
    const vector = new Float32Array(dim);
    for (let i = 0; i < dim; i += 1) {
      const value = values[i];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new EmbedParseError(
          `embedding ${String(index)} has a non-finite element at ${String(i)}`,
        );
      }
      vector[i] = value;
    }
    return vector;
  });
}

// ── The bounded, cancellable spawn seam (mirrors defaultRunWhisper) ──────────

/**
 * A typed `llama-embedding` subprocess failure carrying the exit `code`,
 * terminating `signal`, whether it was killed for overrunning its timeout, whether
 * it was KILLED by a cooperative cancel, and the (bounded) `stderr`.
 */
export class EmbedRunError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stderr: string;
  constructor(
    message: string,
    details: {
      code: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      cancelled: boolean;
      stderr: string;
    },
  ) {
    super(message);
    this.name = 'EmbedRunError';
    this.code = details.code;
    this.signal = details.signal;
    this.timedOut = details.timedOut;
    this.cancelled = details.cancelled;
    this.stderr = details.stderr;
  }
}

/**
 * Run `llama-embedding` to completion and resolve with its stdout (the JSON
 * envelope). Injected so {@link createEmbedder} is unit-testable without a real
 * binary; rejects with {@link EmbedRunError} on a non-zero exit, a spawn error, a
 * timeout kill, or a cooperative cancel.
 */
export type RunEmbedding = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<string>;

/**
 * The production runner: spawn the bundled `llama-embedding` with an array argv (no
 * shell), a bounded stderr buffer, OUR OWN timer that SIGKILLs a child overrunning
 * `timeoutMs`, and an `AbortSignal` listener that SIGKILLs the in-flight child the
 * instant a cancel fires. An already-aborted signal refuses to spawn at all.
 * `timedOut` / `cancelled` are detected precisely (own flags), not inferred from
 * the exit signal. Resolves with the full stdout (the JSON), which the caller
 * parses; stdout size is bounded by the caller's batch against a trusted binary.
 */
export const defaultRunEmbedding: RunEmbedding = (command, args, { timeoutMs, signal }) =>
  new Promise<string>((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(
        new EmbedRunError('llama-embedding cancelled before start', {
          code: null,
          signal: null,
          timedOut: false,
          cancelled: true,
          stderr: '',
        }),
      );
      return;
    }
    const child = spawn(command, [...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const onAbort = (): void => {
      cancelled = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    signal?.addEventListener('abort', onAbort);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      // A HARD cap (slice the overflow) so a single huge chunk can't balloon memory.
      if (stderr.length >= EMBED_STDERR_CAP) return;
      stderr = (stderr + chunk.toString('utf8')).slice(0, EMBED_STDERR_CAP);
    });
    child.on('error', (error: Error) => {
      settle(() =>
        reject(
          new EmbedRunError(`llama-embedding failed to spawn: ${error.message}`, {
            code: null,
            signal: null,
            timedOut,
            cancelled,
            stderr,
          }),
        ),
      );
    });
    child.on('close', (code, closeSignal) => {
      settle(() => {
        if (cancelled) {
          reject(
            new EmbedRunError('llama-embedding cancelled', {
              code,
              signal: closeSignal,
              timedOut,
              cancelled,
              stderr,
            }),
          );
          return;
        }
        if (timedOut) {
          reject(
            new EmbedRunError('llama-embedding timed out', {
              code,
              signal: closeSignal,
              timedOut,
              cancelled,
              stderr,
            }),
          );
          return;
        }
        if (code === 0) {
          resolvePromise(stdout);
          return;
        }
        reject(
          new EmbedRunError(
            `llama-embedding exited (code=${String(code)}, signal=${String(closeSignal)}): ${stderr.slice(0, 500)}`,
            { code, signal: closeSignal, timedOut, cancelled, stderr },
          ),
        );
      });
    });
  });

// ── The temp-input writer seam ──────────────────────────────────────────────

/** A materialized `-f` input file plus its cleanup (removes the scratch dir). */
export interface EmbedInputFile {
  /** Absolute path of the written input file. */
  inputPath: string;
  /** Remove the scratch dir (best-effort); safe to await after the run settles. */
  cleanup: () => Promise<void>;
}

/** Write a batch to a temp `-f` input file (one sanitized line per text). */
export type WriteInputFile = (texts: readonly string[]) => Promise<EmbedInputFile>;

/**
 * The default input writer: create a unique scratch dir under `scratchDir` and
 * write the newline-delimited input into it. Local-file-only, no untrusted path
 * interpolation — the texts are the file's CONTENT, never an argv element.
 */
function makeDefaultWriteInputFile(scratchDir: string): WriteInputFile {
  return async (texts) => {
    const dir = await mkdtemp(join(scratchDir, 'kawsay-embed-'));
    const inputPath = join(dir, 'input.txt');
    await writeFile(inputPath, buildEmbedInput(texts), 'utf8');
    return {
      inputPath,
      cleanup: async (): Promise<void> => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  };
}

// ── The embedder factory ────────────────────────────────────────────────────

/** Why the embedder is unavailable (→ callers fall back to exact FTS, AC-7). */
export type EmbedUnavailableReason = 'binary-unavailable' | 'model-unavailable';

/** Embed a batch of (already-prefixed) texts into 384-dim L2-normalized vectors. */
export type Embedder = (texts: readonly string[]) => Promise<Float32Array[]>;

/**
 * The result of {@link createEmbedder}: EITHER a ready embedder, OR a typed
 * UNAVAILABLE sentinel (never a thrown error) so a caller can degrade to exact FTS
 * with a single `available` check.
 */
export type EmbedderStatus =
  | { readonly available: true; readonly embed: Embedder }
  | { readonly available: false; readonly reason: EmbedUnavailableReason };

/** Collaborators + resolution inputs for {@link createEmbedder} (all injectable). */
export interface EmbedderConfig extends ResolveEmbedFileOptions {
  /** Scratch root for the `-f` input file; defaults to the OS temp dir. */
  scratchDir?: string;
  /** The spawn seam (defaults to the bounded, cancellable production runner). */
  runEmbedding?: RunEmbedding;
  /** The input writer (defaults to a scratch-dir-confined temp-file writer). */
  writeInputFile?: WriteInputFile;
  /** Hard per-invocation timeout (defaults to {@link EMBED_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/**
 * Resolve the bundled binary + model and build an {@link Embedder}, OR return a
 * typed UNAVAILABLE sentinel when either is absent (the case until the packaging
 * slice bundles them) — so smart search falls back to exact FTS. The returned
 * `embed`:
 *   1. short-circuits an empty batch to `[]` (no spawn);
 *   2. writes the texts to a temp `-f` file (one sanitized line each);
 *   3. spawns `llama-embedding` (array argv, local-file-only, hard timeout, no
 *      shell, no network) and parses the JSON into `texts.length` × 384 vectors;
 *   4. ALWAYS removes the scratch input file, even when the run rejects.
 * A runtime failure (non-zero exit, malformed JSON, wrong dimension, timeout) is a
 * REJECTION — only an absent binary/model is the (non-throwing) UNAVAILABLE result.
 */
export function createEmbedder(config: EmbedderConfig): EmbedderStatus {
  const binaryPath = resolveEmbedBinaryPath(config);
  if (binaryPath === null) {
    return { available: false, reason: 'binary-unavailable' };
  }
  const modelPath = resolveEmbedModelPath(config);
  if (modelPath === null) {
    return { available: false, reason: 'model-unavailable' };
  }

  const runEmbedding = config.runEmbedding ?? defaultRunEmbedding;
  const timeoutMs = config.timeoutMs ?? EMBED_TIMEOUT_MS;
  const writeInputFile =
    config.writeInputFile ?? makeDefaultWriteInputFile(config.scratchDir ?? tmpdir());

  const embed: Embedder = async (texts) => {
    if (texts.length === 0) return [];
    const { inputPath, cleanup } = await writeInputFile(texts);
    try {
      const args = buildEmbedArgs({ modelPath, inputPath });
      const stdout = await runEmbedding(binaryPath, args, { timeoutMs });
      return parseEmbeddingJson(stdout, texts.length, EMBED_DIM);
    } finally {
      // A cleanup failure must never mask the embed result (the OS reclaims scratch).
      await cleanup().catch(() => undefined);
    }
  };

  return { available: true, embed };
}
