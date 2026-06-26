import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';
import { installEgressSpies } from '../ac4/egress-spies';
import {
  AUDIO_EXTRACT_FALLBACK_TIMEOUT_MS,
  AUDIO_EXTRACT_MAX_TIMEOUT_MS,
  AUDIO_EXTRACT_STDERR_CAP,
  ERR_AUDIO_SCRATCH_ESCAPE,
  FfmpegRunError,
  TRANSCODE_SUBDIR,
  WHISPER_CHANNELS,
  WHISPER_PCM_CODEC,
  WHISPER_SAMPLE_RATE_HZ,
  audioExtractTimeoutMs,
  buildAudioExtractArgs,
  classifyExtractFailure,
  createAudioExtractor,
  createFfmpegAudioExtractor,
  defaultRunFfmpegToFile,
  removeExtractedWav,
  type RunFfmpegToFile,
} from '../../electron/main/transcription/audio-extract';

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = makeTmpDir(prefix);
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) removeTmpDir(dir);
});

/** A run that simply records its arguments and resolves (a clean decode). */
function recordingRun(): RunFfmpegToFile & {
  calls: { command: string; args: readonly string[]; timeoutMs: number }[];
} {
  const calls: { command: string; args: readonly string[]; timeoutMs: number }[] = [];
  const run = vi.fn(
    async (command: string, args: readonly string[], options: { timeoutMs: number }) => {
      calls.push({ command, args, timeoutMs: options.timeoutMs });
    },
  ) as unknown as RunFfmpegToFile & { calls: typeof calls };
  run.calls = calls;
  return run;
}

describe('buildAudioExtractArgs (the whisper 16 kHz mono PCM s16le WAV argv — ADR-0027 §3)', () => {
  it('decodes to the exact format whisper-cli requires (16000 Hz, mono, pcm_s16le, wav)', () => {
    const args = buildAudioExtractArgs('/in/note.opus', '/scratch/transcode/out.wav');
    expect(Array.isArray(args)).toBe(true);
    // The whisper contract: 16 kHz, single channel, signed 16-bit PCM, WAV container.
    expect(args).toContain('-ar');
    expect(args[args.indexOf('-ar') + 1]).toBe(String(WHISPER_SAMPLE_RATE_HZ));
    expect(args[args.indexOf('-ar') + 1]).toBe('16000');
    expect(args).toContain('-ac');
    expect(args[args.indexOf('-ac') + 1]).toBe(String(WHISPER_CHANNELS));
    expect(args[args.indexOf('-ac') + 1]).toBe('1');
    expect(args).toContain('-c:a');
    expect(args[args.indexOf('-c:a') + 1]).toBe(WHISPER_PCM_CODEC);
    expect(args[args.indexOf('-c:a') + 1]).toBe('pcm_s16le');
    expect(args).toContain('-f');
    expect(args[args.indexOf('-f') + 1]).toBe('wav');
    // Video is dropped so only the audio track is decoded.
    expect(args).toContain('-vn');
  });

  it('is an ARRAY argv with input and output as discrete, non-interpolated elements', () => {
    const args = buildAudioExtractArgs('/in/a v.opus', '/out/a v.wav');
    expect(args).toContain('/in/a v.opus');
    expect(args.at(-1)).toBe('/out/a v.wav'); // output is always the final element
    // The source path is a standalone element, never concatenated into a flag.
    expect(args.every((a) => a === '/in/a v.opus' || !a.includes('/in/a v.opus'))).toBe(true);
  });

  it('pins ffmpeg to the local file protocol BEFORE -i so a crafted container cannot egress (AC-4)', () => {
    const args = buildAudioExtractArgs('/in/note.opus', '/out/note.wav');
    const pw = args.indexOf('-protocol_whitelist');
    expect(pw).toBeGreaterThanOrEqual(0);
    expect(args[pw + 1]).toBe('file');
    expect(pw).toBeLessThan(args.indexOf('-i'));
  });

  it('refuses a remote-style input before building any argv (no spawn, AC-4)', () => {
    expect(() => buildAudioExtractArgs('https://evil.example/x.opus', '/out/x.wav')).toThrow(
      /local file/i,
    );
  });
});

describe('audioExtractTimeoutMs (duration-scaled, NOT the 30 s import cap — ADR-0027 §8 / AC-20)', () => {
  it('scales with media duration and is monotonic', () => {
    expect(audioExtractTimeoutMs(600)).toBeGreaterThan(audioExtractTimeoutMs(60));
    expect(audioExtractTimeoutMs(60)).toBeGreaterThan(audioExtractTimeoutMs(5));
  });

  it('gives a multi-minute recording FAR more than the 30 s flat import cap (long media not killed)', () => {
    // A 10-minute video would be killed at the import seam's flat 30 s; the
    // transcription decode must budget generously instead.
    expect(audioExtractTimeoutMs(10 * 60)).toBeGreaterThan(30_000);
    expect(audioExtractTimeoutMs(60 * 60)).toBeGreaterThan(30_000);
  });

  it('caps a pathological duration at the hard resource ceiling', () => {
    expect(audioExtractTimeoutMs(10_000_000)).toBe(AUDIO_EXTRACT_MAX_TIMEOUT_MS);
  });

  it('falls back to a generous bounded cap when duration is unknown', () => {
    for (const unknown of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(audioExtractTimeoutMs(unknown)).toBe(AUDIO_EXTRACT_FALLBACK_TIMEOUT_MS);
    }
    expect(AUDIO_EXTRACT_FALLBACK_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});

describe('classifyExtractFailure (typed reasons from ffmpeg stderr — AC-20)', () => {
  it('detects a no-audio-stream input (graceful skip, not a crash)', () => {
    expect(classifyExtractFailure('Output file #0 does not contain any stream')).toBe(
      'no-audio-stream',
    );
    expect(classifyExtractFailure("Stream map '0:a' matches no streams.")).toBe('no-audio-stream');
  });

  it('treats an empty output (nothing decodable was encoded) as no-audio-stream, not a crash', () => {
    expect(classifyExtractFailure('Output file is empty, nothing was encoded')).toBe(
      'no-audio-stream',
    );
  });

  it('treats corrupt / missing / unknown failures as a decode failure', () => {
    expect(classifyExtractFailure('Invalid data found when processing input')).toBe(
      'decode-failed',
    );
    expect(classifyExtractFailure('No such file or directory')).toBe('decode-failed');
    expect(classifyExtractFailure('')).toBe('decode-failed');
  });
});

describe('createAudioExtractor (resilient, confined, non-destructive — AC-20 / AC-14 / AC-4)', () => {
  it('decodes a voice note to a confined WAV under the scratch dir and reports the path', async () => {
    const scratch = tmp('extract');
    const run = recordingRun();
    const extract = createAudioExtractor({ ffmpegPath: '/bin/ffmpeg', scratchDir: scratch, run });

    const result = await extract({
      sourcePath: '/src/voice.opus',
      durationSec: 600,
      key: 'item-42',
    });

    expect(result).toEqual({ ok: true, wavPath: join(scratch, TRANSCODE_SUBDIR, 'item-42.wav') });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.command).toBe('/bin/ffmpeg');
    expect(run.calls[0]?.args).toContain('/src/voice.opus');
    expect(run.calls[0]?.args.at(-1)).toBe(join(scratch, TRANSCODE_SUBDIR, 'item-42.wav'));
    // The scratch sub-directory is created before the decode runs.
    expect(existsSync(join(scratch, TRANSCODE_SUBDIR))).toBe(true);
  });

  it('passes the DURATION-SCALED timeout (not a flat 30 s) down to the runner', async () => {
    const scratch = tmp('extract');
    const run = recordingRun();
    const extract = createAudioExtractor({ ffmpegPath: '/bin/ffmpeg', scratchDir: scratch, run });

    await extract({ sourcePath: '/src/long.mp4', durationSec: 45 * 60, key: 'long' });

    expect(run.calls[0]?.timeoutMs).toBe(audioExtractTimeoutMs(45 * 60));
    expect(run.calls[0]?.timeoutMs).toBeGreaterThan(30_000);
  });

  it('uses the generous fallback timeout when the caller gives no duration hint', async () => {
    const scratch = tmp('extract');
    const run = recordingRun();
    const extract = createAudioExtractor({ ffmpegPath: '/bin/ffmpeg', scratchDir: scratch, run });

    await extract({ sourcePath: '/src/unknown.m4a', key: 'nodur' });

    expect(run.calls[0]?.timeoutMs).toBe(AUDIO_EXTRACT_FALLBACK_TIMEOUT_MS);
  });

  it('SKIPS a video with no audio stream with a typed reason — never throws (AC-20)', async () => {
    const scratch = tmp('extract');
    const removeFile = vi.fn(async () => undefined);
    const run: RunFfmpegToFile = async () => {
      throw new FfmpegRunError('no audio', {
        code: 1,
        signal: null,
        timedOut: false,
        stderr: 'Output file #0 does not contain any stream',
      });
    };
    const extract = createAudioExtractor({
      ffmpegPath: '/bin/ffmpeg',
      scratchDir: scratch,
      run,
      removeFile,
    });

    const result = await extract({
      sourcePath: '/src/silent-video.mp4',
      durationSec: 30,
      key: 'na',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-audio-stream');
    // The partial/empty output is cleaned up.
    expect(removeFile).toHaveBeenCalledWith(join(scratch, TRANSCODE_SUBDIR, 'na.wav'));
  });

  it('SKIPS a corrupt input as decode-failed — never throws (AC-20)', async () => {
    const scratch = tmp('extract');
    const run: RunFfmpegToFile = async () => {
      throw new FfmpegRunError('corrupt', {
        code: 183,
        signal: null,
        timedOut: false,
        stderr: 'Invalid data found when processing input',
      });
    };
    const extract = createAudioExtractor({ ffmpegPath: '/bin/ffmpeg', scratchDir: scratch, run });

    const result = await extract({ sourcePath: '/src/corrupt.opus', durationSec: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('decode-failed');
  });

  it('SKIPS long media that exceeds even the scaled timeout as timed-out — never throws (AC-20)', async () => {
    const scratch = tmp('extract');
    const run: RunFfmpegToFile = async () => {
      throw new FfmpegRunError('killed', {
        code: null,
        signal: 'SIGKILL',
        timedOut: true,
        stderr: '',
      });
    };
    const extract = createAudioExtractor({ ffmpegPath: '/bin/ffmpeg', scratchDir: scratch, run });

    const result = await extract({ sourcePath: '/src/huge.mp4', durationSec: 99999 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timed-out');
  });

  it('SKIPS a generic spawn failure as decode-failed — never throws through (binary missing, etc.)', async () => {
    const scratch = tmp('extract');
    const run: RunFfmpegToFile = async () => {
      throw new Error('spawn ffmpeg ENOENT');
    };
    const extract = createAudioExtractor({ ffmpegPath: '/bin/ffmpeg', scratchDir: scratch, run });

    const result = await extract({ sourcePath: '/src/a.opus' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('decode-failed');
  });

  it('SKIPS with a typed scratch-io reason when the scratch dir cannot be created — never throws (AC-20)', async () => {
    const scratch = tmp('extract');
    // Occupy the confined transcode sub-directory's path with a FILE, so creating
    // it as a directory fails (EEXIST/ENOTDIR) — a real scratch-dir I/O failure
    // (the EACCES/EROFS/ENOTDIR/ENOSPC class). It must surface as a typed skip a
    // Promise.all batch can survive, never a thrown rejection that aborts it.
    writeFileSync(join(scratch, TRANSCODE_SUBDIR), Buffer.from('not a directory'));
    const run = recordingRun();
    const extract = createAudioExtractor({ ffmpegPath: '/bin/ffmpeg', scratchDir: scratch, run });

    const result = await extract({ sourcePath: '/src/a.opus', key: 'sio' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scratch-io');
    expect(run.calls).toHaveLength(0); // ffmpeg is never spawned when scratch setup fails
  });

  it('processes a mixed batch to completion — one bad item never aborts the others (AC-20)', async () => {
    const scratch = tmp('extract');
    const run: RunFfmpegToFile = async (_command, args) => {
      const input = args[args.indexOf('-i') + 1];
      if (input === '/src/bad.opus') {
        throw new FfmpegRunError('bad', {
          code: 1,
          signal: null,
          timedOut: false,
          stderr: 'Invalid data found when processing input',
        });
      }
    };
    const extract = createAudioExtractor({ ffmpegPath: '/bin/ffmpeg', scratchDir: scratch, run });

    const results = await Promise.all([
      extract({ sourcePath: '/src/good1.opus', key: 'g1' }),
      extract({ sourcePath: '/src/bad.opus', key: 'b1' }),
      extract({ sourcePath: '/src/good2.opus', key: 'g2' }),
    ]);

    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
  });

  it('removes a partial WAV left on disk when the decode fails (real fs cleanup)', async () => {
    const scratch = tmp('extract');
    const wavPath = join(scratch, TRANSCODE_SUBDIR, 'partial.wav');
    const run: RunFfmpegToFile = async () => {
      // Simulate ffmpeg having written a truncated output before failing.
      writeFileSync(wavPath, Buffer.from('RIFFpartial'));
      throw new FfmpegRunError('boom', {
        code: 1,
        signal: null,
        timedOut: false,
        stderr: 'broken',
      });
    };
    const extract = createAudioExtractor({ ffmpegPath: '/bin/ffmpeg', scratchDir: scratch, run });

    const result = await extract({ sourcePath: '/src/x.opus', key: 'partial' });
    expect(result.ok).toBe(false);
    expect(existsSync(wavPath)).toBe(false); // the partial output is gone
  });

  it('never alters the original source file on failure (non-destructive — AC-14/AC-20)', async () => {
    const root = tmp('extract');
    const source = join(root, 'memory.opus');
    writeFileSync(source, Buffer.from('ORIGINAL-BYTES'));
    const run: RunFfmpegToFile = async () => {
      throw new FfmpegRunError('fail', {
        code: 1,
        signal: null,
        timedOut: false,
        stderr: 'Invalid data found when processing input',
      });
    };
    const extract = createAudioExtractor({ ffmpegPath: '/bin/ffmpeg', scratchDir: root, run });

    await extract({ sourcePath: source, key: 'orig' });
    expect(readFileSync(source).toString()).toBe('ORIGINAL-BYTES');
  });

  it('REJECTS a non-local (URL) source loudly before spawning (contract violation, AC-4)', async () => {
    const scratch = tmp('extract');
    const run = recordingRun();
    const extract = createAudioExtractor({ ffmpegPath: '/bin/ffmpeg', scratchDir: scratch, run });

    await expect(extract({ sourcePath: 'https://evil.example/a.opus' })).rejects.toThrow(
      /local file/i,
    );
    expect(run.calls).toHaveLength(0); // ffmpeg is never spawned on a non-local input
  });

  it('REJECTS a key that would escape the scratch dir before spawning (confinement)', async () => {
    const scratch = tmp('extract');
    const run = recordingRun();
    const extract = createAudioExtractor({ ffmpegPath: '/bin/ffmpeg', scratchDir: scratch, run });

    for (const evil of ['../escape', 'a/b', '..', 'a\0b']) {
      await expect(extract({ sourcePath: '/src/a.opus', key: evil })).rejects.toThrow(
        ERR_AUDIO_SCRATCH_ESCAPE,
      );
    }
    expect(run.calls).toHaveLength(0);
  });

  it('keeps the produced WAV strictly inside the scratch root', async () => {
    const scratch = tmp('extract');
    const run = recordingRun();
    const extract = createAudioExtractor({ ffmpegPath: '/bin/ffmpeg', scratchDir: scratch, run });

    const result = await extract({ sourcePath: '/src/a.opus' }); // default random key
    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolvedRoot = resolve(scratch);
      expect(resolve(result.wavPath).startsWith(resolvedRoot + sep)).toBe(true);
      expect(result.wavPath.endsWith('.wav')).toBe(true);
    }
  });

  it('makes NO network call while orchestrating an extraction (AC-4)', async () => {
    const spies = installEgressSpies();
    try {
      const scratch = tmp('extract');
      const extract = createAudioExtractor({
        ffmpegPath: '/bin/ffmpeg',
        scratchDir: scratch,
        run: recordingRun(),
      });
      await extract({ sourcePath: '/src/a.opus', key: 'noegress' });
      spies.assertNoEgress();
    } finally {
      spies.restore();
    }
  });
});

describe('removeExtractedWav (caller-owned WAV lifecycle)', () => {
  it('deletes the WAV and is a no-op if it is already gone', async () => {
    const scratch = tmp('extract');
    const wavPath = join(scratch, 'done.wav');
    writeFileSync(wavPath, Buffer.from('RIFF'));
    await removeExtractedWav(wavPath);
    expect(existsSync(wavPath)).toBe(false);
    await expect(removeExtractedWav(wavPath)).resolves.toBeUndefined(); // idempotent
  });
});

describe('defaultRunFfmpegToFile (the real bounded spawn seam, via a node stub)', () => {
  it('resolves when the child exits 0', async () => {
    await expect(
      defaultRunFfmpegToFile(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 5000 }),
    ).resolves.toBeUndefined();
  });

  it('rejects with a typed FfmpegRunError carrying the exit code and bounded stderr', async () => {
    const error = await defaultRunFfmpegToFile(
      process.execPath,
      ['-e', 'process.stderr.write("boom-stderr");process.exit(7)'],
      { timeoutMs: 5000 },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegRunError);
    const runError = error as FfmpegRunError;
    expect(runError.code).toBe(7);
    expect(runError.timedOut).toBe(false);
    expect(runError.stderr).toContain('boom-stderr');
  });

  it('maps a spawn failure (binary that cannot be executed) to a FfmpegRunError with code null, not timed out', async () => {
    const error = await defaultRunFfmpegToFile('/no/such/ffmpeg', [], { timeoutMs: 5000 }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(FfmpegRunError);
    const runError = error as FfmpegRunError;
    // A failure to spawn (ENOENT) surfaces via the child 'error' event, not a
    // close code — so there is no exit code and the kill timer never fired.
    expect(runError.code).toBe(null);
    expect(runError.timedOut).toBe(false);
  });

  it('kills and reports timed-out for a child that overruns the timeout', async () => {
    const error = await defaultRunFfmpegToFile(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10000)'],
      { timeoutMs: 100 },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegRunError);
    expect((error as FfmpegRunError).timedOut).toBe(true);
  }, 5000);

  it('bounds captured stderr to the cap so a chatty ffmpeg cannot balloon memory', async () => {
    const error = await defaultRunFfmpegToFile(
      process.execPath,
      ['-e', `process.stderr.write("x".repeat(100000));process.exit(1)`],
      { timeoutMs: 5000 },
    ).catch((e: unknown) => e);

    expect((error as FfmpegRunError).stderr.length).toBeLessThanOrEqual(AUDIO_EXTRACT_STDERR_CAP);
  });
});

describe('createFfmpegAudioExtractor (production wiring to the bundled ffmpeg)', () => {
  it('builds an extractor bound to a scratch dir', () => {
    const scratch = tmp('extract');
    const extract = createFfmpegAudioExtractor({ scratchDir: scratch });
    expect(typeof extract).toBe('function');
  });
});

// An OPTIONAL real-binary integration test. ffmpeg-static's binary is NOT
// downloaded in dev/CI (pnpm `onlyBuiltDependencies` builds only better-sqlite3),
// so this self-skips unless a real ffmpeg is resolvable — an explicit
// `FFMPEG_PATH`, or a present ffmpeg-static binary on disk. Where it runs, it
// proves true format correctness end-to-end: a real decode produces a 16 kHz /
// mono / s16le WAV.
function resolveRealFfmpeg(): string | null {
  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(fromEnv)) return fromEnv;
  if (typeof ffmpegStatic === 'string' && ffmpegStatic.length > 0 && existsSync(ffmpegStatic)) {
    return ffmpegStatic;
  }
  return null;
}

const realFfmpeg = resolveRealFfmpeg();

describe.skipIf(realFfmpeg === null)('audio extraction format correctness (real ffmpeg)', () => {
  it('produces a 16 kHz, mono, 16-bit PCM WAV from a real decode', async () => {
    const scratch = tmp('extract-real');
    // Synthesize a tiny stereo 44.1 kHz s16le WAV as the INPUT (pure JS, no binary).
    const inPath = join(scratch, 'in.wav');
    writeFileSync(inPath, makeStereoWav(44100, 0.25));

    const extract = createFfmpegAudioExtractor({ scratchDir: scratch });
    const result = await extract({ sourcePath: inPath, key: 'real' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const header = parseWavHeader(readFileSync(result.wavPath));
    expect(header.sampleRate).toBe(WHISPER_SAMPLE_RATE_HZ);
    expect(header.channels).toBe(WHISPER_CHANNELS);
    expect(header.bitsPerSample).toBe(16);
    expect(header.audioFormat).toBe(1); // PCM
    expect(dirname(result.wavPath)).toBe(join(scratch, TRANSCODE_SUBDIR));
  });
});

/** Build a minimal PCM s16le WAV (stereo) of `seconds` at `rate` — a silent test tone. */
function makeStereoWav(rate: number, seconds: number): Buffer {
  const channels = 2;
  const bytesPerSample = 2;
  const frames = Math.floor(rate * seconds);
  const dataLen = frames * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(8 * bytesPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

/** Parse the canonical fields out of a PCM WAV header. */
function parseWavHeader(buf: Buffer): {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
} {
  return {
    audioFormat: buf.readUInt16LE(20),
    channels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    bitsPerSample: buf.readUInt16LE(34),
  };
}
