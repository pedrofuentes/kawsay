import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';
import { installEgressSpies } from '../ac4/egress-spies';
import { TRANSCODE_SUBDIR } from '../../electron/main/transcription/audio-extract';
import type {
  AudioExtractRequest,
  AudioExtractResult,
  AudioExtractor,
} from '../../electron/main/transcription/audio-extract';
import type { ModelVerification } from '../../electron/main/transcription/model-integrity';
import {
  TRANSCRIBE_BASE_TIMEOUT_MS,
  TRANSCRIBE_FALLBACK_TIMEOUT_MS,
  TRANSCRIBE_MAX_TIMEOUT_MS,
  WHISPER_DEFAULT_LANGUAGE,
  WHISPER_STDERR_CAP,
  WhisperRunError,
  buildWhisperArgs,
  createTranscriber,
  defaultRunWhisper,
  parseWhisperJson,
  transcribeTimeoutMs,
  type RunWhisper,
  type TranscriberOptions,
  type WhisperJson,
} from '../../electron/main/transcription/transcribe';

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = makeTmpDir(prefix);
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) removeTmpDir(dir);
});

const VERIFIED: ModelVerification = {
  valid: true,
  reason: 'ok',
  actualSize: 487_601_967,
  actualSha256: 'sha',
};

/** A whisper.cpp v1.9.1 `-oj` JSON document (offsets in ms; result.language). */
function whisperJson(
  segments: { from: number; to: number; text: string }[],
  language = 'es',
): WhisperJson {
  return {
    result: { language },
    transcription: segments.map((s) => ({
      timestamps: { from: '00:00:00,000', to: '00:00:00,000' },
      offsets: { from: s.from, to: s.to },
      text: s.text,
    })),
  };
}

/** A scratch dir with the `transcode/` sub-dir the extractor confines WAVs to. */
function scratchWithTranscode(): { scratchDir: string; transcodeDir: string } {
  const scratchDir = tmp('transcribe');
  const transcodeDir = join(scratchDir, TRANSCODE_SUBDIR);
  mkdirSync(transcodeDir, { recursive: true });
  return { scratchDir, transcodeDir };
}

/**
 * A fake {@link AudioExtractor} that returns `result`, writing a stub WAV to the
 * success path so the executor's cleanup can be observed. Records its requests.
 */
function fakeExtractor(
  result: AudioExtractResult,
): AudioExtractor & { calls: AudioExtractRequest[] } {
  const calls: AudioExtractRequest[] = [];
  const fn = (async (request: AudioExtractRequest) => {
    calls.push(request);
    if (result.ok) writeFileSync(result.wavPath, Buffer.from('RIFFstub'));
    return result;
  }) as AudioExtractor & { calls: AudioExtractRequest[] };
  fn.calls = calls;
  return fn;
}

/**
 * A fake {@link RunWhisper} that writes `json` to the `-of` prefix + `.json` (as
 * the real whisper-cli does) and resolves; or rejects with `error` if given one.
 * Records the exact argv + options it was called with.
 */
function fakeRunWhisper(behaviour: {
  json?: WhisperJson;
  rawJson?: string;
  error?: WhisperRunError;
}): RunWhisper & {
  calls: { command: string; args: readonly string[]; timeoutMs: number; signal?: AbortSignal }[];
} {
  const calls: {
    command: string;
    args: readonly string[];
    timeoutMs: number;
    signal?: AbortSignal;
  }[] = [];
  const fn = (async (
    command: string,
    args: readonly string[],
    options: { timeoutMs: number; signal?: AbortSignal },
  ) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs, signal: options.signal });
    if (behaviour.error) throw behaviour.error;
    const prefix = args[args.indexOf('-of') + 1];
    const payload = behaviour.rawJson ?? JSON.stringify(behaviour.json ?? whisperJson([]));
    writeFileSync(`${prefix}.json`, payload);
  }) as RunWhisper & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

function baseOptions(over: Partial<TranscriberOptions>): TranscriberOptions {
  return {
    modelPath: '/models/ggml-small.bin',
    whisperCliPath: '/bin/whisper-cli',
    extractAudio: fakeExtractor({ ok: false, reason: 'decode-failed', message: 'x' }),
    runWhisper: fakeRunWhisper({ json: whisperJson([]) }),
    verifyModel: async () => VERIFIED,
    ...over,
  };
}

// ── buildWhisperArgs ────────────────────────────────────────────────────────

describe('buildWhisperArgs (the exact whisper-cli v1.9.1 argv — ADR-0027 §2)', () => {
  it('passes the model, WAV, language, and JSON output flags as discrete elements', () => {
    const args = buildWhisperArgs({
      modelPath: '/models/ggml-small.bin',
      wavPath: '/scratch/transcode/item.wav',
      outputPrefix: '/scratch/transcode/item',
    });
    expect(args[args.indexOf('-m') + 1]).toBe('/models/ggml-small.bin');
    expect(args[args.indexOf('-f') + 1]).toBe('/scratch/transcode/item.wav');
    // -oj writes structured JSON; -of pins where (so we read a known path).
    expect(args).toContain('-oj');
    expect(args[args.indexOf('-of') + 1]).toBe('/scratch/transcode/item');
    // Default language is auto-detect (multilingual model — AC-21).
    expect(args[args.indexOf('-l') + 1]).toBe(WHISPER_DEFAULT_LANGUAGE);
    expect(WHISPER_DEFAULT_LANGUAGE).toBe('auto');
  });

  it('uses an explicit language hint when provided', () => {
    const args = buildWhisperArgs({
      modelPath: '/m.bin',
      wavPath: '/s/a.wav',
      outputPrefix: '/s/a',
      language: 'es',
    });
    expect(args[args.indexOf('-l') + 1]).toBe('es');
  });

  it('is an ARRAY argv with the paths never interpolated into a flag', () => {
    const args = buildWhisperArgs({
      modelPath: '/m b.bin',
      wavPath: '/s/a v.wav',
      outputPrefix: '/s/a v',
    });
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain('/m b.bin');
    expect(args).toContain('/s/a v.wav');
    expect(args.every((a) => a === '/s/a v.wav' || !a.includes('a v.wav') || a === '/s/a v')).toBe(
      true,
    );
  });

  it('refuses a non-local (URL) WAV input before building any argv (local-file-only, AC-4)', () => {
    expect(() =>
      buildWhisperArgs({
        modelPath: '/m.bin',
        wavPath: 'https://evil.example/a.wav',
        outputPrefix: '/s/a',
      }),
    ).toThrow(/local file/i);
  });

  it('refuses a non-local (URL) model before building any argv (local-file-only, AC-4)', () => {
    expect(() =>
      buildWhisperArgs({
        modelPath: 'http://evil.example/m.bin',
        wavPath: '/s/a.wav',
        outputPrefix: '/s/a',
      }),
    ).toThrow(/local file/i);
  });
});

// ── transcribeTimeoutMs ─────────────────────────────────────────────────────

describe('transcribeTimeoutMs (duration-scaled, NOT the 30 s import cap — ADR-0027 §8 / AC-20)', () => {
  it('scales with media duration and is monotonic', () => {
    expect(transcribeTimeoutMs(600)).toBeGreaterThan(transcribeTimeoutMs(60));
    expect(transcribeTimeoutMs(60)).toBeGreaterThan(transcribeTimeoutMs(5));
    expect(transcribeTimeoutMs(5)).toBeGreaterThanOrEqual(TRANSCRIBE_BASE_TIMEOUT_MS);
  });

  it('gives a multi-minute recording FAR more than the 30 s flat import cap (long media not killed)', () => {
    expect(transcribeTimeoutMs(10 * 60)).toBeGreaterThan(30_000);
    expect(transcribeTimeoutMs(60 * 60)).toBeGreaterThan(30_000);
  });

  it('caps a pathological duration at the hard resource ceiling', () => {
    expect(transcribeTimeoutMs(10_000_000)).toBe(TRANSCRIBE_MAX_TIMEOUT_MS);
  });

  it('falls back to a generous bounded cap when duration is unknown', () => {
    for (const unknown of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(transcribeTimeoutMs(unknown)).toBe(TRANSCRIBE_FALLBACK_TIMEOUT_MS);
    }
    expect(TRANSCRIBE_FALLBACK_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});

// ── parseWhisperJson ────────────────────────────────────────────────────────

describe('parseWhisperJson (whisper.cpp v1.9.1 -oj → typed transcript)', () => {
  it('joins segment text, keeps ms-offset timestamps, and reports the detected language', () => {
    const transcript = parseWhisperJson(
      whisperJson(
        [
          { from: 0, to: 2000, text: ' Hola' },
          { from: 2000, to: 5000, text: ' mundo.' },
        ],
        'es',
      ),
    );
    expect(transcript.text).toBe('Hola mundo.');
    expect(transcript.language).toBe('es');
    expect(transcript.segments).toEqual([
      { startMs: 0, endMs: 2000, text: 'Hola' },
      { startMs: 2000, endMs: 5000, text: 'mundo.' },
    ]);
  });

  it('returns an empty transcript (no segments) for a no-speech result', () => {
    const transcript = parseWhisperJson(whisperJson([], 'en'));
    expect(transcript.text).toBe('');
    expect(transcript.segments).toEqual([]);
    expect(transcript.language).toBe('en');
  });

  it('defaults missing offsets to 0 and tolerates a missing transcription array', () => {
    expect(parseWhisperJson({ result: { language: 'pt' }, transcription: [{ text: ' hi' }] })).toEqual(
      { text: 'hi', language: 'pt', segments: [{ startMs: 0, endMs: 0, text: 'hi' }] },
    );
    expect(parseWhisperJson({})).toEqual({ text: '', language: null, segments: [] });
  });

  it('reports a null language when whisper emitted none', () => {
    expect(parseWhisperJson({ transcription: [] }).language).toBeNull();
    expect(parseWhisperJson({ result: { language: '' }, transcription: [] }).language).toBeNull();
  });
});

// ── defaultRunWhisper (the real bounded + cancellable spawn seam) ────────────

describe('defaultRunWhisper (real spawn seam via a node stub — AC-20 child-kill)', () => {
  it('resolves when the child exits 0', async () => {
    await expect(
      defaultRunWhisper(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 5000 }),
    ).resolves.toBeUndefined();
  });

  it('rejects with a typed WhisperRunError carrying the exit code and bounded stderr', async () => {
    const error = await defaultRunWhisper(
      process.execPath,
      ['-e', 'process.stderr.write("boom-stderr");process.exit(7)'],
      { timeoutMs: 5000 },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WhisperRunError);
    const runError = error as WhisperRunError;
    expect(runError.code).toBe(7);
    expect(runError.timedOut).toBe(false);
    expect(runError.cancelled).toBe(false);
    expect(runError.stderr).toContain('boom-stderr');
  });

  it('maps a spawn failure to a WhisperRunError with code null (not timed out, not cancelled)', async () => {
    const error = await defaultRunWhisper('/no/such/whisper-cli', [], { timeoutMs: 5000 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WhisperRunError);
    expect((error as WhisperRunError).code).toBe(null);
    expect((error as WhisperRunError).timedOut).toBe(false);
    expect((error as WhisperRunError).cancelled).toBe(false);
  });

  it('kills and reports timed-out for a child that overruns the timeout (long-media safety net)', async () => {
    const error = await defaultRunWhisper(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 100,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhisperRunError);
    expect((error as WhisperRunError).timedOut).toBe(true);
    expect((error as WhisperRunError).cancelled).toBe(false);
  }, 5000);

  it('KILLS the in-flight child when the AbortSignal fires mid-run (cancel kills the child — AC-20)', async () => {
    const controller = new AbortController();
    const pending = defaultRunWhisper(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 10_000,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    // Cancel while the child is still running (well before its own timeout).
    setTimeout(() => controller.abort(), 50);
    const error = await pending;
    expect(error).toBeInstanceOf(WhisperRunError);
    expect((error as WhisperRunError).cancelled).toBe(true);
    expect((error as WhisperRunError).timedOut).toBe(false);
  }, 5000);

  it('refuses to start when the signal is already aborted (no spawn)', async () => {
    const error = await defaultRunWhisper(process.execPath, ['-e', 'process.exit(0)'], {
      timeoutMs: 5000,
      signal: AbortSignal.abort(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhisperRunError);
    expect((error as WhisperRunError).cancelled).toBe(true);
  });

  it('bounds captured stderr to the cap so a chatty whisper-cli cannot balloon memory', async () => {
    const error = await defaultRunWhisper(
      process.execPath,
      ['-e', `process.stderr.write("x".repeat(100000));process.exit(1)`],
      { timeoutMs: 5000 },
    ).catch((e: unknown) => e);
    expect((error as WhisperRunError).stderr.length).toBeLessThanOrEqual(WHISPER_STDERR_CAP);
  });
});

// ── createTranscriber (the per-item executor) ───────────────────────────────

describe('createTranscriber (verify → extract → whisper → parse → cleanup)', () => {
  it('re-verifies the model on disk FIRST and skips with model-unavailable when invalid (AC-24)', async () => {
    const extractAudio = fakeExtractor({ ok: false, reason: 'decode-failed', message: 'x' });
    const runWhisper = fakeRunWhisper({ json: whisperJson([]) });
    const transcribe = createTranscriber(
      baseOptions({
        extractAudio,
        runWhisper,
        verifyModel: async () => ({
          valid: false,
          reason: 'hash-mismatch',
          actualSize: 1,
          actualSha256: 'bad',
        }),
      }),
    );

    const result = await transcribe({ id: 'i1', sourcePath: '/src/note.opus' });
    expect(result).toMatchObject({ ok: false, id: 'i1', reason: 'model-unavailable' });
    // The model gate is BEFORE any extraction or spawn.
    expect(extractAudio.calls).toHaveLength(0);
    expect(runWhisper.calls).toHaveLength(0);
  });

  it.each([
    ['no-audio-stream', 'no-audio-stream'],
    ['decode-failed', 'decode-failed'],
    ['timed-out', 'extract-timed-out'],
    ['scratch-io', 'scratch-io'],
  ] as const)(
    'propagates an audio-extract %s skip as a typed transcription skip (never throws — AC-20)',
    async (extractReason, expected) => {
      const runWhisper = fakeRunWhisper({ json: whisperJson([]) });
      const transcribe = createTranscriber(
        baseOptions({
          extractAudio: fakeExtractor({ ok: false, reason: extractReason, message: 'boom' }),
          runWhisper,
        }),
      );

      const result = await transcribe({ id: 'i2', sourcePath: '/src/x.opus' });
      expect(result).toMatchObject({ ok: false, id: 'i2', reason: expected });
      expect(runWhisper.calls).toHaveLength(0); // no spawn when extraction skipped
    },
  );

  it('transcribes a real WAV path: exact argv, parsed transcript, scratch cleaned up', async () => {
    const { transcodeDir } = scratchWithTranscode();
    const wavPath = join(transcodeDir, 'i3.wav');
    const jsonPath = join(transcodeDir, 'i3.json');
    const runWhisper = fakeRunWhisper({
      json: whisperJson(
        [
          { from: 0, to: 1500, text: ' Te' },
          { from: 1500, to: 3000, text: ' extraño.' },
        ],
        'es',
      ),
    });
    const transcribe = createTranscriber(
      baseOptions({
        modelPath: '/models/ggml-small.bin',
        whisperCliPath: '/bin/whisper-cli',
        extractAudio: fakeExtractor({ ok: true, wavPath }),
        runWhisper,
      }),
    );

    const result = await transcribe({ id: 'i3', sourcePath: '/src/voice.opus', durationSec: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transcript.text).toBe('Te extraño.');
    expect(result.transcript.language).toBe('es');
    expect(result.transcript.segments).toHaveLength(2);

    // The exact whisper-cli invocation.
    const call = runWhisper.calls[0];
    expect(call.command).toBe('/bin/whisper-cli');
    expect(call.args[call.args.indexOf('-m') + 1]).toBe('/models/ggml-small.bin');
    expect(call.args[call.args.indexOf('-f') + 1]).toBe(wavPath);
    expect(call.args).toContain('-oj');
    // Scratch WAV + JSON are both removed (no accumulation — re-run safe).
    expect(existsSync(wavPath)).toBe(false);
    expect(existsSync(jsonPath)).toBe(false);
  });

  it('passes the duration-scaled timeout AND the AbortSignal through to the spawn (cancel wiring)', async () => {
    const { transcodeDir } = scratchWithTranscode();
    const wavPath = join(transcodeDir, 'i4.wav');
    const runWhisper = fakeRunWhisper({ json: whisperJson([{ from: 0, to: 10, text: ' hi' }]) });
    const signal = new AbortController().signal;
    const transcribe = createTranscriber(
      baseOptions({ extractAudio: fakeExtractor({ ok: true, wavPath }), runWhisper }),
    );

    await transcribe({ id: 'i4', sourcePath: '/src/a.opus', durationSec: 42 }, { signal });
    expect(runWhisper.calls[0].timeoutMs).toBe(transcribeTimeoutMs(42));
    expect(runWhisper.calls[0].signal).toBe(signal);
  });

  it.each([
    [{ timedOut: false, cancelled: false }, 'whisper-failed'],
    [{ timedOut: true, cancelled: false }, 'whisper-timed-out'],
    [{ timedOut: false, cancelled: true }, 'cancelled'],
  ] as const)(
    'maps a whisper-cli failure (%o) to a typed skip and cleans up (never throws — AC-20)',
    async (flags, expected) => {
      const { transcodeDir } = scratchWithTranscode();
      const wavPath = join(transcodeDir, 'i5.wav');
      const error = new WhisperRunError('whisper failed', {
        code: flags.timedOut || flags.cancelled ? null : 2,
        signal: flags.cancelled || flags.timedOut ? 'SIGKILL' : null,
        timedOut: flags.timedOut,
        cancelled: flags.cancelled,
        stderr: 'err',
      });
      const transcribe = createTranscriber(
        baseOptions({
          extractAudio: fakeExtractor({ ok: true, wavPath }),
          runWhisper: fakeRunWhisper({ error }),
        }),
      );

      const result = await transcribe({ id: 'i5', sourcePath: '/src/a.opus' });
      expect(result).toMatchObject({ ok: false, id: 'i5', reason: expected });
      expect(existsSync(wavPath)).toBe(false); // partial WAV cleaned up
    },
  );

  it('reports no-speech for an empty transcript (a calm, typed skip — AC-20)', async () => {
    const { transcodeDir } = scratchWithTranscode();
    const wavPath = join(transcodeDir, 'i6.wav');
    const transcribe = createTranscriber(
      baseOptions({
        extractAudio: fakeExtractor({ ok: true, wavPath }),
        runWhisper: fakeRunWhisper({ json: whisperJson([]) }),
      }),
    );

    const result = await transcribe({ id: 'i6', sourcePath: '/src/silent.opus' });
    expect(result).toMatchObject({ ok: false, id: 'i6', reason: 'no-speech' });
  });

  it('treats unreadable / malformed whisper output as a whisper-failed skip', async () => {
    const { transcodeDir } = scratchWithTranscode();
    const wavPath = join(transcodeDir, 'i7.wav');
    const transcribe = createTranscriber(
      baseOptions({
        extractAudio: fakeExtractor({ ok: true, wavPath }),
        runWhisper: fakeRunWhisper({ rawJson: '{ this is not valid json' }),
      }),
    );

    const result = await transcribe({ id: 'i7', sourcePath: '/src/a.opus' });
    expect(result).toMatchObject({ ok: false, id: 'i7', reason: 'whisper-failed' });
  });

  it('short-circuits to cancelled when the signal is already aborted (no extract, no spawn)', async () => {
    const extractAudio = fakeExtractor({ ok: false, reason: 'decode-failed', message: 'x' });
    const runWhisper = fakeRunWhisper({ json: whisperJson([]) });
    const transcribe = createTranscriber(baseOptions({ extractAudio, runWhisper }));

    const result = await transcribe(
      { id: 'i8', sourcePath: '/src/a.opus' },
      { signal: AbortSignal.abort() },
    );
    expect(result).toMatchObject({ ok: false, id: 'i8', reason: 'cancelled' });
    expect(extractAudio.calls).toHaveLength(0);
    expect(runWhisper.calls).toHaveLength(0);
  });

  it('never alters the original source file (non-destructive — AC-14/AC-20)', async () => {
    const root = tmp('transcribe-src');
    const source = join(root, 'memory.opus');
    writeFileSync(source, Buffer.from('ORIGINAL-BYTES'));
    const { transcodeDir } = scratchWithTranscode();
    const wavPath = join(transcodeDir, 'i9.wav');
    const transcribe = createTranscriber(
      baseOptions({
        extractAudio: fakeExtractor({ ok: true, wavPath }),
        runWhisper: fakeRunWhisper({ json: whisperJson([{ from: 0, to: 10, text: ' hi' }]) }),
      }),
    );

    await transcribe({ id: 'i9', sourcePath: source });
    expect(readFileSync(source).toString()).toBe('ORIGINAL-BYTES');
  });

  it('makes NO network call while transcribing (AC-4)', async () => {
    const spies = installEgressSpies();
    try {
      const { transcodeDir } = scratchWithTranscode();
      const wavPath = join(transcodeDir, 'i10.wav');
      const transcribe = createTranscriber(
        baseOptions({
          extractAudio: fakeExtractor({ ok: true, wavPath }),
          runWhisper: fakeRunWhisper({ json: whisperJson([{ from: 0, to: 10, text: ' hi' }]) }),
        }),
      );
      await transcribe({ id: 'i10', sourcePath: '/src/a.opus' });
      spies.assertNoEgress();
    } finally {
      spies.restore();
    }
  });

  it('defaults verifyModel to the on-disk re-verification bound to the model path', async () => {
    // No verifyModel override: the executor must build one from verifyModelOnDisk
    // against a (here absent) model path, so the result is a model-unavailable skip
    // rather than a crash — proving the default gate is wired (AC-24).
    const extractAudio = fakeExtractor({ ok: false, reason: 'decode-failed', message: 'x' });
    const transcribe = createTranscriber({
      modelPath: join(tmp('no-model'), 'ggml-small.bin'),
      whisperCliPath: '/bin/whisper-cli',
      extractAudio,
      runWhisper: fakeRunWhisper({ json: whisperJson([]) }),
    });

    const result = await transcribe({ id: 'i11', sourcePath: '/src/a.opus' });
    expect(result).toMatchObject({ ok: false, reason: 'model-unavailable' });
    expect(extractAudio.calls).toHaveLength(0);
  });
});
