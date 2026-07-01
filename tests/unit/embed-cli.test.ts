import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';
import { installEgressSpies } from '../ac4/egress-spies';
import {
  EMBED_CLI_BINARY_BASENAME,
  EMBED_DIM,
  EMBED_MODEL_FILENAME,
  EMBED_RESOURCE_SUBDIR,
  EMBED_STDERR_CAP,
  EMBED_TIMEOUT_MS,
  EmbedParseError,
  EmbedRunError,
  PASSAGE_PREFIX,
  QUERY_PREFIX,
  SUPPORTED_EMBED_TARGETS,
  buildEmbedArgs,
  buildEmbedInput,
  createEmbedder,
  defaultRunEmbedding,
  embedArchDir,
  embedCliBinaryName,
  embedOsKey,
  parseEmbeddingJson,
  resolveEmbedBinaryPath,
  resolveEmbedModelPath,
  toEmbeddingInputLine,
  withPassagePrefix,
  withQueryPrefix,
  type EmbedderConfig,
  type RunEmbedding,
} from '../../electron/main/search/embed-cli';

// The embed-cli subprocess wrapper (M4-1b · ADR-0029 Decision 1). It resolves the
// bundled llama.cpp `llama-embedding` binary + the multilingual-e5-small GGUF and
// turns a batch of texts into 384-dim L2-normalized float vectors. NEITHER the
// binary NOR the model is bundled yet (that is the later packaging slice), so the
// governing contract these tests pin is GRACEFUL DEGRADATION: when the binary or
// model is absent (the case today, in dev, and in CI), the wrapper returns a typed
// UNAVAILABLE sentinel — never a throw — so callers fall back to exact FTS (AC-7).
// The seam is fully injectable (spawn + fs), so it is exercised WITHOUT a real
// binary, exactly like the whisper-cli seam it mirrors.

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = makeTmpDir(prefix);
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) removeTmpDir(dir);
});

/** A constant 384-float vector (values are irrelevant to the parser). */
function vec(dim = EMBED_DIM, fill = 0.0125): number[] {
  return new Array<number>(dim).fill(fill);
}

/** The exact llama.cpp `--embd-output-format json` envelope (OpenAI-style). */
function envelope(vectors: number[][]): unknown {
  return {
    object: 'list',
    data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
  };
}

// ── Prefix helpers (e5 query/passage asymmetry — caller's responsibility) ─────

describe('withQueryPrefix / withPassagePrefix (e5 asymmetric prefixes)', () => {
  it('prepends "query: " to a search query', () => {
    expect(withQueryPrefix('abuela cocinando')).toBe('query: abuela cocinando');
    expect(QUERY_PREFIX).toBe('query: ');
  });

  it('prepends "passage: " to a stored item', () => {
    expect(withPassagePrefix('foto de la playa')).toBe('passage: foto de la playa');
    expect(PASSAGE_PREFIX).toBe('passage: ');
  });

  it('embeds the exact string it is given (prefixes are opt-in, never doubled here)', () => {
    // The wrapper prepends verbatim — it does not dedupe an already-prefixed string;
    // callers choose exactly one prefix per text.
    expect(withQueryPrefix('')).toBe('query: ');
    expect(withPassagePrefix('query: x')).toBe('passage: query: x');
  });
});

// ── Platform/arch mapping (mirrors media-binaries.ts / whisper-cli.ts) ────────

describe('embedOsKey / embedCliBinaryName / embedArchDir', () => {
  it('maps darwin→mac and win32→win, and returns null for unshipped platforms', () => {
    expect(embedOsKey('darwin')).toBe('mac');
    expect(embedOsKey('win32')).toBe('win');
    // Graceful (null), not a throw: the wrapper degrades to UNAVAILABLE everywhere
    // it is not shipped, so a dev on Linux still falls back to FTS cleanly.
    expect(embedOsKey('linux')).toBeNull();
  });

  it('uses the .exe suffix on Windows and the bare basename elsewhere', () => {
    expect(embedCliBinaryName('win32')).toBe('llama-embedding.exe');
    expect(embedCliBinaryName('darwin')).toBe('llama-embedding');
    expect(embedCliBinaryName('darwin')).toBe(EMBED_CLI_BINARY_BASENAME);
  });

  it('produces exactly the shipped <os>-<arch> bundle dirs, null otherwise', () => {
    expect(embedArchDir('darwin', 'arm64')).toBe('mac-arm64');
    expect(embedArchDir('darwin', 'x64')).toBe('mac-x64');
    expect(embedArchDir('win32', 'x64')).toBe('win-x64');
    // Windows arm64 is deferred (ADR-0007); a non-arm64/x64 arch is unshipped.
    expect(embedArchDir('win32', 'arm64')).toBeNull();
    expect(embedArchDir('darwin', 'ia32')).toBeNull();
    expect(embedArchDir('linux', 'x64')).toBeNull();
  });

  it('enumerates exactly the three shipped targets (matches whisper/media)', () => {
    expect([...SUPPORTED_EMBED_TARGETS].sort()).toEqual(['mac-arm64', 'mac-x64', 'win-x64']);
  });
});

// ── Binary/model path resolution (dev vs packaged; null when absent) ──────────

describe('resolveEmbedBinaryPath / resolveEmbedModelPath', () => {
  const present = (): boolean => true;

  it('resolves the binary under process.resourcesPath in a packaged app', () => {
    const resourcesPath = join('/Applications', 'Kawsay.app', 'Contents', 'Resources');
    expect(
      resolveEmbedBinaryPath({
        isPackaged: true,
        resourcesPath,
        projectRoot: '/unused/in/packaged',
        platform: 'darwin',
        arch: 'arm64',
        exists: present,
      }),
    ).toBe(join(resourcesPath, EMBED_RESOURCE_SUBDIR, 'mac-arm64', 'llama-embedding'));
  });

  it('resolves the model GGUF alongside the binary (same <os>-<arch> dir)', () => {
    const resourcesPath = '/opt/kawsay/resources';
    expect(
      resolveEmbedModelPath({
        isPackaged: true,
        resourcesPath,
        projectRoot: '/unused',
        platform: 'win32',
        arch: 'x64',
        exists: present,
      }),
    ).toBe(join(resourcesPath, EMBED_RESOURCE_SUBDIR, 'win-x64', EMBED_MODEL_FILENAME));
  });

  it('resolves under the repo resources/ tree in development (with .exe on win)', () => {
    const projectRoot = join('/home', 'dev', 'kawsay');
    expect(
      resolveEmbedBinaryPath({
        isPackaged: false,
        resourcesPath: '/unused/in/dev',
        projectRoot,
        platform: 'win32',
        arch: 'x64',
        exists: present,
      }),
    ).toBe(join(projectRoot, 'resources', EMBED_RESOURCE_SUBDIR, 'win-x64', 'llama-embedding.exe'));
  });

  it('returns null (NOT a throw) when the binary is absent — degrade to FTS', () => {
    expect(
      resolveEmbedBinaryPath({
        isPackaged: true,
        resourcesPath: '/opt/kawsay/resources',
        projectRoot: '/unused',
        platform: 'darwin',
        arch: 'x64',
        exists: () => false,
      }),
    ).toBeNull();
  });

  it('returns null when the model GGUF is absent', () => {
    expect(
      resolveEmbedModelPath({
        isPackaged: false,
        resourcesPath: '/unused',
        projectRoot: '/repo',
        platform: 'darwin',
        arch: 'arm64',
        exists: () => false,
      }),
    ).toBeNull();
  });

  it('returns null for an unshipped platform/arch instead of throwing', () => {
    expect(
      resolveEmbedBinaryPath({
        isPackaged: true,
        resourcesPath: '/opt/kawsay/resources',
        projectRoot: '/unused',
        platform: 'linux',
        arch: 'x64',
        exists: present,
      }),
    ).toBeNull();
  });

  it('defaults platform/arch to the current process and probes with fs by default', () => {
    // No binary is bundled in this checkout, so the default fs.existsSync probe
    // misses and resolution returns null (the wrapper is unavailable today).
    expect(
      resolveEmbedBinaryPath({
        isPackaged: false,
        resourcesPath: '/unused',
        projectRoot: '/nonexistent-kawsay-root',
      }),
    ).toBeNull();
    // Sanity: the default probe really is fs.existsSync.
    expect(existsSync('/nonexistent-kawsay-root')).toBe(false);
  });
});

// ── Input-line sanitation (guarantees N texts → N embeddings) ─────────────────

describe('toEmbeddingInputLine / buildEmbedInput (newline-collapse safety)', () => {
  it('collapses embedded CR/LF to a single space so one text stays one line', () => {
    // llama-embedding splits its -f input on "\n" (one prompt per line); an
    // embedded newline in a caption/description would otherwise become TWO prompts
    // and desync the N-in/N-out contract. Each text is flattened to a single line.
    expect(toEmbeddingInputLine('hello\nworld')).toBe('hello world');
    expect(toEmbeddingInputLine('a\r\nb\rc')).toBe('a b c');
  });

  it('joins the batch with newlines so each text is exactly one line', () => {
    const input = buildEmbedInput(['passage: one', 'passage: two\nlines', 'passage: three']);
    expect(input.split('\n')).toEqual(['passage: one', 'passage: two lines', 'passage: three']);
  });

  it('preserves the line count even for empty texts (N in → N lines out)', () => {
    expect(buildEmbedInput(['a', '', 'c']).split('\n')).toHaveLength(3);
  });
});

// ── Argv construction (array argv, validated flags, flag-injection guard) ──────

describe('buildEmbedArgs (the validated llama-embedding argv)', () => {
  it('builds the exact spike-validated array argv (model, input file, json, mean, L2)', () => {
    expect(buildEmbedArgs({ modelPath: '/m/model.gguf', inputPath: '/scratch/input.txt' })).toEqual([
      '-m',
      '/m/model.gguf',
      '-f',
      '/scratch/input.txt',
      '--embd-output-format',
      'json',
      '--pooling',
      'mean',
      '--embd-normalize',
      '2',
    ]);
  });

  it('refuses a path that could be misread as a flag (defense-in-depth)', () => {
    // Our own resolved/temp paths never begin with "-", but the exported builder
    // guards the argv boundary so no path can ever inject a flag.
    expect(() => buildEmbedArgs({ modelPath: '-m', inputPath: '/scratch/input.txt' })).toThrow();
    expect(() =>
      buildEmbedArgs({ modelPath: '/m/model.gguf', inputPath: '--evil' }),
    ).toThrow();
    expect(() => buildEmbedArgs({ modelPath: '', inputPath: '/scratch/input.txt' })).toThrow();
  });
});

// ── JSON → Float32Array[] parsing (shape, dim, count, finiteness) ─────────────

describe('parseEmbeddingJson', () => {
  it('parses the llama.cpp json envelope into N × 384 Float32Array vectors', () => {
    const raw = JSON.stringify(envelope([vec(), vec()]));
    const out = parseEmbeddingJson(raw, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[0].length).toBe(EMBED_DIM);
    expect(out[1].length).toBe(384);
    expect(out[0][0]).toBeCloseTo(0.0125, 5);
  });

  it('tolerates a bare array-of-arrays (the --embd-output-format array shape)', () => {
    const raw = JSON.stringify([vec(), vec(), vec()]);
    expect(parseEmbeddingJson(raw, 3)).toHaveLength(3);
  });

  it('tolerates leading/trailing log noise around the json object', () => {
    // stderr is separate, but be robust if a stray line leaks onto stdout.
    const raw = `load time = 12ms\n${JSON.stringify(envelope([vec()]))}\n`;
    const out = parseEmbeddingJson(raw, 1);
    expect(out[0].length).toBe(384);
  });

  it('throws EmbedParseError on malformed JSON', () => {
    expect(() => parseEmbeddingJson('not json {[', 1)).toThrow(EmbedParseError);
  });

  it('throws when a well-formed envelope entry carries no embedding array', () => {
    // A structurally-valid { data } envelope whose entry is missing its numeric
    // vector must be rejected, never coerced into an empty/garbage vector.
    expect(() => parseEmbeddingJson(JSON.stringify({ data: [{ index: 0 }] }), 1)).toThrow(
      EmbedParseError,
    );
    expect(() => parseEmbeddingJson(JSON.stringify([123]), 1)).toThrow(EmbedParseError);
  });

  it('throws when the returned count does not match the expected count', () => {
    const raw = JSON.stringify(envelope([vec()]));
    expect(() => parseEmbeddingJson(raw, 2)).toThrow(EmbedParseError);
  });

  it('throws on a dimension mismatch (a vector that is not 384-d)', () => {
    const raw = JSON.stringify(envelope([vec(383)]));
    expect(() => parseEmbeddingJson(raw, 1)).toThrow(EmbedParseError);
  });

  it('throws on a non-finite element (a broken vector must never be accepted)', () => {
    const broken = vec();
    const raw = JSON.stringify(envelope([broken])).replace('0.0125', 'null');
    expect(() => parseEmbeddingJson(raw, 1)).toThrow(EmbedParseError);
  });

  it('defaults the expected dimension to EMBED_DIM (384)', () => {
    const raw = JSON.stringify(envelope([vec()]));
    expect(parseEmbeddingJson(raw, 1)[0].length).toBe(384);
  });
});

// ── The real bounded spawn seam (exercised via a node stub, no real binary) ───

describe('defaultRunEmbedding (real spawn seam via a node stub)', () => {
  it('resolves with stdout when the child exits 0 (returns the canned JSON)', async () => {
    const payload = JSON.stringify(envelope([vec(3)]));
    const code = `process.stdout.write(${JSON.stringify(payload)})`;
    await expect(
      defaultRunEmbedding(process.execPath, ['-e', code], { timeoutMs: 5000 }),
    ).resolves.toBe(payload);
  });

  it('rejects with a typed EmbedRunError carrying the exit code and bounded stderr', async () => {
    const error = await defaultRunEmbedding(
      process.execPath,
      ['-e', 'process.stderr.write("boom-embed");process.exit(9)'],
      { timeoutMs: 5000 },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbedRunError);
    const runError = error as EmbedRunError;
    expect(runError.code).toBe(9);
    expect(runError.timedOut).toBe(false);
    expect(runError.cancelled).toBe(false);
    expect(runError.stderr).toContain('boom-embed');
  });

  it('maps a spawn failure (missing binary) to an EmbedRunError with code null', async () => {
    const error = await defaultRunEmbedding('/no/such/llama-embedding', [], {
      timeoutMs: 5000,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbedRunError);
    expect((error as EmbedRunError).code).toBeNull();
    expect((error as EmbedRunError).timedOut).toBe(false);
  });

  it('kills and reports timed-out for a child that overruns the timeout', async () => {
    const error = await defaultRunEmbedding(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10000)'],
      { timeoutMs: 100 },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbedRunError);
    expect((error as EmbedRunError).timedOut).toBe(true);
    expect((error as EmbedRunError).cancelled).toBe(false);
  }, 5000);

  it('KILLS the in-flight child when the AbortSignal fires mid-run', async () => {
    const controller = new AbortController();
    const pending = defaultRunEmbedding(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 10_000,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 50);
    const error = await pending;
    expect(error).toBeInstanceOf(EmbedRunError);
    expect((error as EmbedRunError).cancelled).toBe(true);
    expect((error as EmbedRunError).timedOut).toBe(false);
  }, 5000);

  it('refuses to start when the signal is already aborted (no spawn)', async () => {
    const error = await defaultRunEmbedding(process.execPath, ['-e', 'process.exit(0)'], {
      timeoutMs: 5000,
      signal: AbortSignal.abort(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbedRunError);
    expect((error as EmbedRunError).cancelled).toBe(true);
  });

  it('bounds captured stderr to the cap so a chatty child cannot balloon memory', async () => {
    const error = await defaultRunEmbedding(
      process.execPath,
      ['-e', `process.stderr.write("x".repeat(100000));process.exit(1)`],
      { timeoutMs: 5000 },
    ).catch((e: unknown) => e);
    expect((error as EmbedRunError).stderr.length).toBeLessThanOrEqual(EMBED_STDERR_CAP);
  });
});

// ── createEmbedder (resolve → UNAVAILABLE sentinel | write → run → parse) ──────

/** A recording fake {@link RunEmbedding}: returns canned JSON (or throws). */
function fakeRun(behaviour: {
  json?: unknown;
  raw?: string;
  error?: EmbedRunError;
  captureInput?: boolean;
}): RunEmbedding & {
  calls: { command: string; args: readonly string[]; timeoutMs: number }[];
  inputs: string[];
} {
  const calls: { command: string; args: readonly string[]; timeoutMs: number }[] = [];
  const inputs: string[] = [];
  const fn = (async (
    command: string,
    args: readonly string[],
    options: { timeoutMs: number; signal?: AbortSignal },
  ) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    if (behaviour.captureInput) inputs.push(readFileSync(args[args.indexOf('-f') + 1], 'utf8'));
    if (behaviour.error) throw behaviour.error;
    return behaviour.raw ?? JSON.stringify(behaviour.json ?? envelope([]));
  }) as RunEmbedding & { calls: typeof calls; inputs: typeof inputs };
  fn.calls = calls;
  fn.inputs = inputs;
  return fn;
}

/** A fake input writer that never touches disk (records the texts it was given). */
function fakeWriter(): EmbedderConfig['writeInputFile'] & { texts: readonly string[][] } {
  const texts: string[][] = [];
  const write = (async (batch: readonly string[]) => {
    texts.push([...batch]);
    return { inputPath: '/scratch/input.txt', cleanup: async (): Promise<void> => undefined };
  }) as NonNullable<EmbedderConfig['writeInputFile']> & { texts: string[][] };
  write.texts = texts;
  return write;
}

function baseConfig(over: Partial<EmbedderConfig> = {}): EmbedderConfig {
  return {
    isPackaged: true,
    resourcesPath: '/res',
    projectRoot: '/repo',
    platform: 'darwin',
    arch: 'arm64',
    exists: () => true,
    runEmbedding: fakeRun({ json: envelope([]) }),
    writeInputFile: fakeWriter(),
    ...over,
  };
}

describe('createEmbedder (graceful UNAVAILABLE + happy/error embed paths)', () => {
  it('returns a typed UNAVAILABLE sentinel (not a throw) when the binary is absent', () => {
    const embedder = createEmbedder(baseConfig({ exists: () => false }));
    expect(embedder.available).toBe(false);
    if (!embedder.available) expect(embedder.reason).toBe('binary-unavailable');
  });

  it('returns UNAVAILABLE (model-unavailable) when the binary is present but the model is not', () => {
    // Binary present, GGUF absent.
    const embedder = createEmbedder(baseConfig({ exists: (p) => !p.endsWith('.gguf') }));
    expect(embedder.available).toBe(false);
    if (!embedder.available) expect(embedder.reason).toBe('model-unavailable');
  });

  it('is UNAVAILABLE on an unshipped platform (Linux dev → FTS fallback)', () => {
    const embedder = createEmbedder(baseConfig({ platform: 'linux' }));
    expect(embedder.available).toBe(false);
  });

  it('embeds a batch: writes texts, spawns with the validated argv, returns N × 384', async () => {
    const run = fakeRun({ json: envelope([vec(), vec()]) });
    const embedder = createEmbedder(baseConfig({ runEmbedding: run }));
    expect(embedder.available).toBe(true);
    if (!embedder.available) return;

    const vectors = await embedder.embed([withPassagePrefix('hola'), withPassagePrefix('mundo')]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0].length).toBe(384);

    expect(run.calls).toHaveLength(1);
    const call = run.calls[0];
    expect(call.command).toBe(join('/res', EMBED_RESOURCE_SUBDIR, 'mac-arm64', 'llama-embedding'));
    expect(call.args).toEqual(
      buildEmbedArgs({
        modelPath: join('/res', EMBED_RESOURCE_SUBDIR, 'mac-arm64', EMBED_MODEL_FILENAME),
        inputPath: '/scratch/input.txt',
      }),
    );
    expect(call.timeoutMs).toBe(EMBED_TIMEOUT_MS);
  });

  it('short-circuits an empty batch to [] without spawning', async () => {
    const run = fakeRun({ json: envelope([]) });
    const embedder = createEmbedder(baseConfig({ runEmbedding: run }));
    if (!embedder.available) throw new Error('expected available');
    await expect(embedder.embed([])).resolves.toEqual([]);
    expect(run.calls).toHaveLength(0);
  });

  it('honours a custom timeout override', async () => {
    const run = fakeRun({ json: envelope([vec()]) });
    const embedder = createEmbedder(baseConfig({ runEmbedding: run, timeoutMs: 4242 }));
    if (!embedder.available) throw new Error('expected available');
    await embedder.embed(['passage: x']);
    expect(run.calls[0].timeoutMs).toBe(4242);
  });

  it('writes each text as one sanitized line to a real temp file, then cleans it up', async () => {
    // Exercises the DEFAULT input writer against a confined scratch dir (never /tmp).
    const scratchDir = tmp('embed-scratch');
    const run = fakeRun({ json: envelope([vec(), vec()]), captureInput: true });
    const embedder = createEmbedder(
      baseConfig({ runEmbedding: run, writeInputFile: undefined, scratchDir }),
    );
    if (!embedder.available) throw new Error('expected available');

    await embedder.embed(['passage: uno\ndos', 'passage: tres']);
    expect(run.inputs[0].split('\n')).toEqual(['passage: uno dos', 'passage: tres']);

    // The scratch input file the writer created was removed after the run.
    const inputPath = run.calls[0].args[run.calls[0].args.indexOf('-f') + 1];
    expect(existsSync(inputPath)).toBe(false);
  });

  it('rejects (does not return UNAVAILABLE) on a non-zero exit', async () => {
    const error = new EmbedRunError('llama-embedding exited', {
      code: 2,
      signal: null,
      timedOut: false,
      cancelled: false,
      stderr: 'boom',
    });
    const embedder = createEmbedder(baseConfig({ runEmbedding: fakeRun({ error }) }));
    if (!embedder.available) throw new Error('expected available');
    await expect(embedder.embed(['passage: x'])).rejects.toBeInstanceOf(EmbedRunError);
  });

  it('rejects on malformed JSON output', async () => {
    const embedder = createEmbedder(baseConfig({ runEmbedding: fakeRun({ raw: 'not-json{[' }) }));
    if (!embedder.available) throw new Error('expected available');
    await expect(embedder.embed(['passage: x'])).rejects.toBeInstanceOf(EmbedParseError);
  });

  it('rejects on a dimension mismatch (a non-384-d vector)', async () => {
    const embedder = createEmbedder(
      baseConfig({ runEmbedding: fakeRun({ json: envelope([vec(200)]) }) }),
    );
    if (!embedder.available) throw new Error('expected available');
    await expect(embedder.embed(['passage: x'])).rejects.toBeInstanceOf(EmbedParseError);
  });

  it('rejects when the timeout fires (a timed-out child surfaces as a rejection)', async () => {
    const error = new EmbedRunError('llama-embedding timed out', {
      code: null,
      signal: 'SIGKILL',
      timedOut: true,
      cancelled: false,
      stderr: '',
    });
    const embedder = createEmbedder(baseConfig({ runEmbedding: fakeRun({ error }) }));
    if (!embedder.available) throw new Error('expected available');
    const thrown = await embedder.embed(['passage: x']).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(EmbedRunError);
    expect((thrown as EmbedRunError).timedOut).toBe(true);
  });

  it('cleans up the temp input file even when the run rejects', async () => {
    const scratchDir = tmp('embed-scratch-fail');
    const error = new EmbedRunError('boom', {
      code: 1,
      signal: null,
      timedOut: false,
      cancelled: false,
      stderr: '',
    });
    const run = fakeRun({ error, captureInput: false });
    const embedder = createEmbedder(
      baseConfig({ runEmbedding: run, writeInputFile: undefined, scratchDir }),
    );
    if (!embedder.available) throw new Error('expected available');
    await embedder.embed(['passage: x']).catch(() => undefined);
    const inputPath = run.calls[0].args[run.calls[0].args.indexOf('-f') + 1];
    expect(existsSync(inputPath)).toBe(false);
  });
});

// ── AC-4: the embed flow makes zero in-process network calls ──────────────────

describe('AC-4 — embedding performs no in-process network egress', () => {
  it('records zero outbound attempts across a full embed call', async () => {
    const spies = installEgressSpies();
    try {
      const embedder = createEmbedder(baseConfig({ runEmbedding: fakeRun({ json: envelope([vec()]) }) }));
      if (!embedder.available) throw new Error('expected available');
      await embedder.embed([withQueryPrefix('recuerdos')]);
      spies.assertNoEgress();
    } finally {
      spies.restore();
    }
  });
});
