import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { assertLocalMediaPath } from '../importers/deps/media-path';

// Audio extraction for M2 on-device transcription (ADR-0027 §3, extends ADR-0012).
//
// whisper.cpp's `whisper-cli` consumes ONE specific format: 16 kHz, mono, signed
// 16-bit little-endian PCM in a WAV container. This module reuses the bundled
// ffmpeg through the SAME hardened `spawn` seam as the importer deps
// (`electron/main/importers/deps/{thumbnail,ffprobe}.ts`) — an array argv (never
// a shell string), `-protocol_whitelist file` / local-file-only inputs, a hard
// timeout, and a bounded stderr cap — to decode any voice note (`.opus`), audio,
// or video audio track to that WAV. It builds NOTHING downstream (no worker,
// model download, queue, or UI — those are separate M2 cards); it only turns one
// local media file into the WAV those steps need, resiliently.

/** Sample rate `whisper-cli` requires (Hz). */
export const WHISPER_SAMPLE_RATE_HZ = 16_000;
/** Channel count `whisper-cli` requires (mono). */
export const WHISPER_CHANNELS = 1;
/** PCM codec `whisper-cli` requires (signed 16-bit little-endian). */
export const WHISPER_PCM_CODEC = 'pcm_s16le';

/** Sub-directory under the scratch root that extracted WAVs are confined to. */
export const TRANSCODE_SUBDIR = 'transcode';

/** Cap captured stderr so a chatty ffmpeg can't balloon memory (§7.2). */
export const AUDIO_EXTRACT_STDERR_CAP = 4096;

// ── Duration-scaled timeout (ADR-0027 §8 / AC-20) ───────────────────────────
//
// The import seam hard-caps every child at a flat 30 s
// (`FFPROBE_TIMEOUT_MS`/`FFMPEG_TIMEOUT_MS`) — fine for a single thumbnail frame,
// but it would KILL the decode of a multi-minute recording. Transcription decode
// therefore scales the timeout with the media's duration. Decoding+resampling to
// 16 kHz mono is far FASTER than real time (typically tens of × on modest
// hardware), so budgeting ~1× real time plus a fixed base is deliberately loose:
// it trades an over-generous upper bound for ZERO false kills of legitimate long
// media, while the absolute MAX ceiling preserves a hard resource cap so a hung
// or looping decode still cannot run forever (§7.2). When the caller has no
// duration hint, a generous bounded fallback is used instead.

/** Fixed startup/IO budget added to every decode (also the floor for short clips). */
const AUDIO_EXTRACT_BASE_TIMEOUT_MS = 30_000;
/** Per-second-of-media budget (~1× real time — ≫ the real, faster-than-real-time decode cost). */
const AUDIO_EXTRACT_MS_PER_MEDIA_SECOND = 1_000;
/** Absolute ceiling (2 h) — a hard resource cap so a hung decode can't run forever. */
export const AUDIO_EXTRACT_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
/** Generous bounded cap used when the media duration is unknown (30 min). */
export const AUDIO_EXTRACT_FALLBACK_TIMEOUT_MS = 30 * 60 * 1_000;

/**
 * The hard timeout (ms) for decoding `durationSec` of media. Scales with
 * duration (never the flat 30 s import cap), clamped to a 2 h ceiling; an unknown
 * / non-positive / non-finite duration degrades to the generous fallback cap.
 */
export function audioExtractTimeoutMs(durationSec: number | null | undefined): number {
  if (
    durationSec === null ||
    durationSec === undefined ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0
  ) {
    return AUDIO_EXTRACT_FALLBACK_TIMEOUT_MS;
  }
  const scaled =
    AUDIO_EXTRACT_BASE_TIMEOUT_MS + Math.ceil(durationSec) * AUDIO_EXTRACT_MS_PER_MEDIA_SECOND;
  return Math.min(scaled, AUDIO_EXTRACT_MAX_TIMEOUT_MS);
}

/**
 * Build the ffmpeg argv that decodes a single LOCAL media file to the 16 kHz
 * mono PCM s16le WAV `whisper-cli` requires (ADR-0027 §3, fully hardened:
 * `ffmpeg -y -loglevel error -protocol_whitelist file -i in -vn -ar 16000 -ac 1 -c:a pcm_s16le -f wav out.wav`).
 *
 * Pure, and crucially an ARRAY argv: the input and output are discrete elements,
 * never concatenated into a flag or a shell string, so an attacker-controlled
 * filename cannot inject flags or shell syntax (§7.2, AC-4). The output path is
 * always the final element. `-protocol_whitelist file` precedes `-i` so it binds
 * the input demuxer — a crafted local container can never make ffmpeg follow an
 * embedded remote reference (egress, AC-4) — and `assertLocalMediaPath` refuses a
 * URL-style input outright. `-vn` drops any video track so only audio is decoded
 * (and a video with NO audio fails cleanly with "does not contain any stream",
 * which the extractor classifies as a graceful skip rather than a crash).
 */
export function buildAudioExtractArgs(inputPath: string, outputPath: string): string[] {
  assertLocalMediaPath(inputPath);
  return [
    '-y',
    '-loglevel',
    'error',
    '-protocol_whitelist',
    'file',
    '-i',
    inputPath,
    '-vn',
    '-ar',
    String(WHISPER_SAMPLE_RATE_HZ),
    '-ac',
    String(WHISPER_CHANNELS),
    '-c:a',
    WHISPER_PCM_CODEC,
    '-f',
    'wav',
    outputPath,
  ];
}

/** Why an extraction was skipped (a typed, reportable reason — AC-20). */
export type AudioExtractReason = 'no-audio-stream' | 'decode-failed' | 'timed-out' | 'scratch-io';

/** A successful decode: the caller now OWNS `wavPath` (see {@link removeExtractedWav}). */
export interface AudioExtractOk {
  ok: true;
  wavPath: string;
}
/** A skipped item: reported with a typed reason, never thrown (AC-20). */
export interface AudioExtractSkip {
  ok: false;
  reason: AudioExtractReason;
  message: string;
}
/** The result of an extraction attempt — a skip is data, not an exception. */
export type AudioExtractResult = AudioExtractOk | AudioExtractSkip;

/** A single media item to decode. `durationSec` (if known) scales the timeout. */
export interface AudioExtractRequest {
  /** Absolute LOCAL path of the source media (voice note / audio / video). */
  sourcePath: string;
  /** Media duration in seconds, if known — scales the decode timeout (AC-20). */
  durationSec?: number | null;
  /** Stable, filesystem-safe output stem (e.g. an item id); defaults to a UUID. */
  key?: string;
}

/**
 * A typed ffmpeg subprocess failure carrying the exit `code`, terminating
 * `signal`, whether the child was killed for overrunning its timeout, and the
 * (bounded) `stderr` — enough for the extractor to classify the skip reason.
 */
export class FfmpegRunError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stderr: string;
  constructor(
    message: string,
    details: {
      code: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      stderr: string;
    },
  ) {
    super(message);
    this.name = 'FfmpegRunError';
    this.code = details.code;
    this.signal = details.signal;
    this.timedOut = details.timedOut;
    this.stderr = details.stderr;
  }
}

/**
 * Run ffmpeg to completion writing to a file. Injected so the extractor is
 * unit-testable without a real binary; rejects with {@link FfmpegRunError} on a
 * non-zero exit, a spawn error, or a timeout kill.
 */
export type RunFfmpegToFile = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<void>;

/**
 * The production runner: spawn the bundled ffmpeg with an array argv (no shell),
 * a bounded stderr buffer, and OUR OWN timer that kills (`SIGKILL`) a child that
 * overruns `timeoutMs` — so `timedOut` is detected precisely rather than inferred
 * from a signal. Mirrors the importer-deps spawn hardening but with the
 * per-call, duration-scaled timeout transcription needs (ADR-0027 §8).
 */
export const defaultRunFfmpegToFile: RunFfmpegToFile = (command, args, { timeoutMs }) =>
  new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, [...args], { windowsHide: true });
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      // A HARD cap (slice the overflow): a single huge stderr chunk can't balloon
      // memory, so the captured diagnostic is strictly bounded (§7.2, AC-20).
      if (stderr.length >= AUDIO_EXTRACT_STDERR_CAP) return;
      stderr = (stderr + chunk.toString('utf8')).slice(0, AUDIO_EXTRACT_STDERR_CAP);
    });
    child.on('error', (error: Error) => {
      settle(() =>
        reject(
          new FfmpegRunError(`ffmpeg failed to spawn: ${error.message}`, {
            code: null,
            signal: null,
            timedOut,
            stderr,
          }),
        ),
      );
    });
    child.on('close', (code, signal) => {
      settle(() => {
        if (!timedOut && code === 0) {
          resolvePromise();
          return;
        }
        reject(
          new FfmpegRunError(
            `ffmpeg exited (code=${String(code)}, signal=${String(signal)})${timedOut ? ' [timed out]' : ''}: ${stderr.slice(0, 500)}`,
            { code, signal, timedOut, stderr },
          ),
        );
      });
    });
  });

/** Thrown for an output key that would escape the confined scratch sub-directory. */
export const ERR_AUDIO_SCRATCH_ESCAPE = 'ERR_AUDIO_SCRATCH_ESCAPE';

/** A safe output stem: dotted alphanumerics, dashes, underscores — no separators, no `..`, no NUL. */
const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

/**
 * Resolve the confined absolute WAV path for `key` under `scratchDir`'s transcode
 * sub-directory. The key is generated by us (a UUID) by default, but is validated
 * AND the resolved path is re-checked to stay strictly inside the scratch root, so
 * even a hostile caller-supplied key can never write outside it (defense in depth).
 */
function confinedWavPath(scratchDir: string, key: string): string {
  if (key.length === 0 || key === '.' || key.includes('..') || !SAFE_KEY.test(key)) {
    throw new Error(`${ERR_AUDIO_SCRATCH_ESCAPE}: unsafe extraction key`);
  }
  const transcodeDir = join(resolve(scratchDir), TRANSCODE_SUBDIR);
  const wavPath = join(transcodeDir, `${key}.wav`);
  if (!resolve(wavPath).startsWith(transcodeDir + sep)) {
    throw new Error(`${ERR_AUDIO_SCRATCH_ESCAPE}: path escapes scratch root`);
  }
  return wavPath;
}

/**
 * Classify an ffmpeg failure from its stderr into a typed, reportable reason.
 * A video/file with no decodable audio fails with ffmpeg's "does not contain any
 * stream" / "matches no streams" — a graceful skip, not a crash; everything else
 * (corrupt, truncated, missing, unreadable) is a generic decode failure.
 */
export function classifyExtractFailure(
  stderr: string,
): Exclude<AudioExtractReason, 'timed-out' | 'scratch-io'> {
  if (/does not contain any stream|matches no streams|Output file is empty/i.test(stderr)) {
    return 'no-audio-stream';
  }
  return 'decode-failed';
}

/** Best-effort removal of an output file (ignores a not-yet-written / already-gone path). */
async function safeRemove(
  removeFile: (path: string) => Promise<void>,
  path: string,
): Promise<void> {
  try {
    await removeFile(path);
  } catch {
    // Best-effort cleanup — a missing partial output is not an error.
  }
}

export interface AudioExtractorOptions {
  /** Absolute path of the ffmpeg binary (e.g. ffmpeg-static). */
  ffmpegPath: string;
  /** Confined scratch root; extracted WAVs live under `<scratchDir>/transcode/`. */
  scratchDir: string;
  /** Subprocess runner; defaults to spawning the bundled ffmpeg with an array argv. */
  run?: RunFfmpegToFile;
  /** Output-file remover (for failure cleanup); defaults to `fs.rm({ force: true })`. */
  removeFile?: (path: string) => Promise<void>;
  /** Output-stem generator when the caller gives none; defaults to a UUID. */
  makeKey?: () => string;
}

/** Decode one local media item to a confined 16 kHz mono PCM WAV, or a typed skip. */
export type AudioExtractor = (request: AudioExtractRequest) => Promise<AudioExtractResult>;

/**
 * Build an {@link AudioExtractor} over injected collaborators. A NON-LOCAL (URL)
 * source or an escaping key throws LOUDLY (a programming/contract violation that
 * must never reach this seam, mirroring the importer-deps convention), but a
 * genuine runtime failure — a corrupt input, no audio stream, a timeout on huge
 * media, or a scratch-dir I/O error — is caught and returned as a typed
 * {@link AudioExtractSkip} so one bad item is reported and never aborts a batch
 * (AC-20). Originals are never written; on failure any partial output is cleaned
 * up. On success the caller OWNS the WAV.
 */
export function createAudioExtractor(options: AudioExtractorOptions): AudioExtractor {
  const run = options.run ?? defaultRunFfmpegToFile;
  const removeFile = options.removeFile ?? ((path: string) => rm(path, { force: true }));
  const makeKey = options.makeKey ?? randomUUID;
  return async (request) => {
    // Contract violations (URL input / escaping key) throw before any spawn.
    const wavPath = confinedWavPath(options.scratchDir, request.key ?? makeKey());
    const args = buildAudioExtractArgs(request.sourcePath, wavPath);
    try {
      // Creating the confined scratch sub-directory is itself I/O that can fail
      // (EACCES/EROFS/ENOTDIR/ENOSPC). A failure here is a typed skip, never a
      // thrown rejection — so one unwritable item can't abort a Promise.all
      // batch the way a reject would (AC-20). No partial output exists to clean up.
      await mkdir(dirname(wavPath), { recursive: true });
    } catch (error) {
      return {
        ok: false,
        reason: 'scratch-io',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const timeoutMs = audioExtractTimeoutMs(request.durationSec);
    try {
      await run(options.ffmpegPath, args, { timeoutMs });
      return { ok: true, wavPath };
    } catch (error) {
      await safeRemove(removeFile, wavPath);
      if (error instanceof FfmpegRunError) {
        const reason: AudioExtractReason = error.timedOut
          ? 'timed-out'
          : classifyExtractFailure(error.stderr);
        return { ok: false, reason, message: error.message };
      }
      return {
        ok: false,
        reason: 'decode-failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

/**
 * Remove a WAV produced by a successful extraction. The success-path WAV is
 * caller-owned (the transcription step feeds it to `whisper-cli` and is then
 * responsible for deleting it); this is the convenience cleanup it should call.
 */
export async function removeExtractedWav(wavPath: string): Promise<void> {
  await rm(wavPath, { force: true });
}

export interface FfmpegAudioExtractorOptions {
  /** Confined scratch root; extracted WAVs live under `<scratchDir>/transcode/`. */
  scratchDir: string;
}

/**
 * The production {@link AudioExtractor} wired to the bundled ffmpeg (ffmpeg-static),
 * with the real spawn runner and the duration-scaled timeout.
 */
export function createFfmpegAudioExtractor(options: FfmpegAudioExtractorOptions): AudioExtractor {
  const ffmpegPath: string | null = ffmpegStatic;
  if (ffmpegPath === null) {
    throw new Error('ffmpeg-static did not resolve a binary for this platform');
  }
  return createAudioExtractor({ ffmpegPath, scratchDir: options.scratchDir });
}
