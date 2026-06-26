import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { assertLocalMediaPath } from '../importers/deps/media-path';
import { verifyModelOnDisk } from './model-integrity';
import type { ModelVerification } from './model-integrity';
import type { AudioExtractor, AudioExtractReason } from './audio-extract';

// The per-item transcription EXECUTOR for M2 (ADR-0027 §2, issue #134). Given one
// local media item it: re-verifies the model on disk (AC-24), decodes the audio to
// the 16 kHz mono WAV whisper.cpp needs (reusing the #133 extractor), then spawns
// the bundled `whisper-cli` (whisper.cpp v1.9.1) through the SAME hardened seam as
// the importer deps — an array argv (never a shell string), local-file-only inputs,
// a bounded stderr buffer, and OUR OWN duration-scaled timer that SIGKILLs a child
// that overruns (NOT the flat 30 s import cap, so long media is never false-killed).
// A cooperative `AbortSignal` KILLS the in-flight child mid-file (AC-20). Every
// failure (missing model, a typed extract skip, a non-zero/timed-out/cancelled
// child, unreadable output, or no speech) becomes a TYPED skip — it is data, never
// a throw — so a batch can report it and carry on (AC-20). The source is never
// modified (AC-14) and no network is touched (AC-4). This module builds NOTHING
// downstream: no DB persistence (#135), no UI (#136), no IPC channel — it only
// exposes the clean main-process API those cards consume.

/** The language hint that lets the multilingual model auto-detect (AC-21). */
export const WHISPER_DEFAULT_LANGUAGE = 'auto';

/** Cap captured stderr so a chatty whisper-cli can't balloon memory (§7.2, AC-20). */
export const WHISPER_STDERR_CAP = 8192;

// ── Duration-scaled timeout (ADR-0027 §8 / AC-20) ───────────────────────────
//
// Transcription is the SLOW step: whisper.cpp on CPU can run SLOWER than real time
// (the audio decode in #133 is faster than real time, hence its tighter 1× budget).
// So the per-item timeout scales generously with the media's duration — never the
// flat 30 s import cap, which would kill any multi-minute recording — trading an
// over-generous upper bound for ZERO false kills of legitimate long media. The
// absolute MAX ceiling still preserves a hard resource cap so a hung/looping child
// cannot run forever, and an unknown duration degrades to a generous bounded cap.

/** Fixed startup/IO budget added to every transcription (also the floor for short clips). */
export const TRANSCRIBE_BASE_TIMEOUT_MS = 60_000;
/** Per-second-of-media budget (~10× real time — whisper-cli on CPU can be slower than real time). */
export const TRANSCRIBE_MS_PER_MEDIA_SECOND = 10_000;
/** Absolute ceiling (6 h) — a hard resource cap so a hung transcription can't run forever. */
export const TRANSCRIBE_MAX_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
/** Generous bounded cap used when the media duration is unknown (1 h). */
export const TRANSCRIBE_FALLBACK_TIMEOUT_MS = 60 * 60 * 1_000;

/**
 * The hard timeout (ms) for transcribing `durationSec` of media. Scales with
 * duration (never the flat 30 s import cap), clamped to the 6 h ceiling; an unknown
 * / non-positive / non-finite duration degrades to the generous fallback cap.
 */
export function transcribeTimeoutMs(durationSec: number | null | undefined): number {
  if (
    durationSec === null ||
    durationSec === undefined ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0
  ) {
    return TRANSCRIBE_FALLBACK_TIMEOUT_MS;
  }
  const scaled =
    TRANSCRIBE_BASE_TIMEOUT_MS + Math.ceil(durationSec) * TRANSCRIBE_MS_PER_MEDIA_SECOND;
  return Math.min(scaled, TRANSCRIBE_MAX_TIMEOUT_MS);
}

// ── whisper-cli argv (ADR-0027 §2) ──────────────────────────────────────────

/** Inputs for {@link buildWhisperArgs}. */
export interface BuildWhisperArgsOptions {
  /** Absolute LOCAL path of the verified model (`ggml-small.bin`). */
  modelPath: string;
  /** Absolute LOCAL path of the 16 kHz mono WAV produced by the extractor. */
  wavPath: string;
  /** Output file prefix; whisper-cli writes the JSON to `<outputPrefix>.json`. */
  outputPrefix: string;
  /** Optional explicit language (BCP-ish code); defaults to auto-detect. */
  language?: string;
}

/**
 * Build the whisper-cli argv that transcribes ONE local WAV with the model, emitting
 * structured JSON to a known path. Pure, and crucially an ARRAY argv: the model, WAV
 * and output prefix are discrete elements, never concatenated into a flag or a shell
 * string, so an attacker-controlled filename cannot inject flags or shell syntax
 * (§7.2, AC-4). `-oj` writes a structured JSON transcript (segments + ms offsets +
 * detected language) and `-of` pins WHERE, so the executor reads a deterministic
 * path. `assertLocalMediaPath` refuses a URL-style WAV or model outright — the inputs
 * are always local files (local-file-only, AC-4).
 */
export function buildWhisperArgs({
  modelPath,
  wavPath,
  outputPrefix,
  language,
}: BuildWhisperArgsOptions): string[] {
  assertLocalMediaPath(wavPath);
  assertLocalMediaPath(modelPath);
  return [
    '-m',
    modelPath,
    '-f',
    wavPath,
    '-l',
    language && language.length > 0 ? language : WHISPER_DEFAULT_LANGUAGE,
    '-oj',
    '-of',
    outputPrefix,
  ];
}

// ── whisper-cli JSON → typed transcript ─────────────────────────────────────

/** One segment as whisper.cpp v1.9.1 emits it under `-oj` (offsets in MILLISECONDS). */
export interface WhisperSegmentJson {
  timestamps?: { from?: string; to?: string };
  offsets?: { from?: number; to?: number };
  text?: string;
}

/** The shape of a whisper.cpp v1.9.1 `-oj` JSON document (only the parts we read). */
export interface WhisperJson {
  result?: { language?: string };
  transcription?: WhisperSegmentJson[];
}

/** A single transcript segment with millisecond offsets (ADR-0027 §2). */
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

/** A parsed transcript: the full text, detected language (or null), and segments. */
export interface Transcript {
  text: string;
  language: string | null;
  segments: TranscriptSegment[];
}

/** Detected language as a non-empty string, or null when whisper emitted none. */
function normaliseLanguage(language: string | undefined): string | null {
  return typeof language === 'string' && language.length > 0 ? language : null;
}

/**
 * Parse a whisper.cpp v1.9.1 `-oj` document into a typed {@link Transcript}. Segment
 * `text` carries a leading space in whisper's output, so each is trimmed; empty /
 * padding segments are dropped; offsets are the millisecond `from`/`to` (defaulting
 * to 0 when absent). The full text joins the trimmed segments with single spaces, and
 * the language is `result.language` (null when absent or empty). A missing
 * `transcription` array yields an empty, no-speech transcript rather than a throw.
 */
export function parseWhisperJson(json: WhisperJson): Transcript {
  const segments: TranscriptSegment[] = [];
  for (const raw of json.transcription ?? []) {
    const text = (raw.text ?? '').trim();
    if (text.length === 0) continue;
    segments.push({
      startMs: raw.offsets?.from ?? 0,
      endMs: raw.offsets?.to ?? 0,
      text,
    });
  }
  return {
    text: segments.map((segment) => segment.text).join(' '),
    language: normaliseLanguage(json.result?.language),
    segments,
  };
}

// ── The bounded, cancellable spawn seam ─────────────────────────────────────

/**
 * A typed whisper-cli subprocess failure carrying the exit `code`, terminating
 * `signal`, whether the child was killed for overrunning its timeout, whether it was
 * KILLED by a cooperative cancel, and the (bounded) `stderr` — enough for the
 * executor to classify the skip reason (AC-20).
 */
export class WhisperRunError extends Error {
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
    this.name = 'WhisperRunError';
    this.code = details.code;
    this.signal = details.signal;
    this.timedOut = details.timedOut;
    this.cancelled = details.cancelled;
    this.stderr = details.stderr;
  }
}

/**
 * Run whisper-cli to completion (it writes the JSON transcript to the `-of` prefix as
 * a side effect). Injected so the executor is unit-testable without a real binary;
 * rejects with {@link WhisperRunError} on a non-zero exit, a spawn error, a timeout
 * kill, or a cooperative cancel.
 */
export type RunWhisper = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<void>;

/**
 * The production runner: spawn the bundled whisper-cli with an array argv (no shell),
 * a bounded stderr buffer, a drained stdout (so a chatty child can't deadlock on a
 * full pipe), OUR OWN timer that SIGKILLs a child overrunning `timeoutMs`, AND an
 * `AbortSignal` listener that SIGKILLs the in-flight child the instant a cancel fires
 * (AC-20). An already-aborted signal refuses to spawn at all. `timedOut`/`cancelled`
 * are detected precisely (own flags) rather than inferred from the exit signal.
 */
export const defaultRunWhisper: RunWhisper = (command, args, { timeoutMs, signal }) =>
  new Promise<void>((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(
        new WhisperRunError('whisper-cli cancelled before start', {
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
    // Drain stdout: whisper-cli prints the transcript there by default; we read the
    // JSON file instead, but an unread pipe could fill and deadlock the child.
    child.stdout?.resume();
    child.stderr?.on('data', (chunk: Buffer) => {
      // A HARD cap (slice the overflow) so a single huge chunk can't balloon memory.
      if (stderr.length >= WHISPER_STDERR_CAP) return;
      stderr = (stderr + chunk.toString('utf8')).slice(0, WHISPER_STDERR_CAP);
    });
    child.on('error', (error: Error) => {
      settle(() =>
        reject(
          new WhisperRunError(`whisper-cli failed to spawn: ${error.message}`, {
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
            new WhisperRunError('whisper-cli cancelled', {
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
            new WhisperRunError('whisper-cli timed out', {
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
          resolvePromise();
          return;
        }
        reject(
          new WhisperRunError(
            `whisper-cli exited (code=${String(code)}, signal=${String(closeSignal)}): ${stderr.slice(0, 500)}`,
            { code, signal: closeSignal, timedOut, cancelled, stderr },
          ),
        );
      });
    });
  });

// ── The per-item executor ───────────────────────────────────────────────────

/** A single media item to transcribe. `durationSec` (if known) scales the timeout. */
export interface TranscribeItem {
  /** Stable, filesystem-safe id (used as the extractor's output stem). */
  id: string;
  /** Absolute LOCAL path of the source media (voice note / audio / video). */
  sourcePath: string;
  /** Media duration in seconds, if known — scales the transcription timeout (AC-20). */
  durationSec?: number | null;
  /** Optional per-item language hint; defaults to the transcriber's, then auto-detect. */
  language?: string;
}

/** Why a transcription was skipped — a typed, reportable reason that never throws (AC-20). */
export type TranscribeSkipReason =
  | 'model-unavailable'
  | 'no-audio-stream'
  | 'decode-failed'
  | 'extract-timed-out'
  | 'scratch-io'
  | 'whisper-failed'
  | 'whisper-timed-out'
  | 'no-speech'
  | 'cancelled';

/** A successful transcription. */
export interface TranscribeOk {
  ok: true;
  id: string;
  transcript: Transcript;
}

/** A skipped item: reported with a typed reason, never thrown (AC-20). */
export interface TranscribeSkip {
  ok: false;
  id: string;
  reason: TranscribeSkipReason;
  message: string;
}

/** The result of a transcription attempt — a skip is data, not an exception. */
export type TranscribeResult = TranscribeOk | TranscribeSkip;

/** Per-call context: a cooperative cancel signal that KILLS the in-flight child (AC-20). */
export interface TranscribeContext {
  signal?: AbortSignal;
}

/** Transcribe one item into a typed result; never throws for a media-level failure. */
export type Transcriber = (item: TranscribeItem, ctx?: TranscribeContext) => Promise<TranscribeResult>;

/** Collaborators for {@link createTranscriber} (all injectable for unit tests). */
export interface TranscriberOptions {
  /** Absolute LOCAL path of the model on disk (`ggml-small.bin`). */
  modelPath: string;
  /** Absolute LOCAL path of the resolved per-arch `whisper-cli` binary. */
  whisperCliPath: string;
  /** Decodes the source to a 16 kHz mono WAV (reuse the #133 extractor). */
  extractAudio: AudioExtractor;
  /** The whisper-cli runner (defaults to the bounded, cancellable production seam). */
  runWhisper?: RunWhisper;
  /** Re-verify the model on disk BEFORE each spawn (defaults to `verifyModelOnDisk(modelPath)`, AC-24). */
  verifyModel?: () => Promise<ModelVerification>;
  /** Read the whisper-cli JSON output file (defaults to reading UTF-8 from disk). */
  readJson?: (path: string) => Promise<string>;
  /** Remove a scratch file (defaults to `rm` with `force`); used for cleanup. */
  removeFile?: (path: string) => Promise<void>;
  /** Optional default language hint applied when an item has none. */
  language?: string;
}

/** Map a typed audio-extract skip onto the transcription skip vocabulary. */
function mapExtractReason(reason: AudioExtractReason): TranscribeSkipReason {
  switch (reason) {
    case 'no-audio-stream':
      return 'no-audio-stream';
    case 'decode-failed':
      return 'decode-failed';
    case 'timed-out':
      return 'extract-timed-out';
    case 'scratch-io':
      return 'scratch-io';
  }
}

/** A human-readable message for any thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Best-effort cleanup: a cleanup failure must never mask the result (AC-20). */
async function safeRemove(removeFile: (path: string) => Promise<void>, path: string): Promise<void> {
  try {
    await removeFile(path);
  } catch {
    // Intentionally ignored — the scratch file is transient and the OS will reclaim it.
  }
}

/**
 * Create the per-item transcription executor. The returned {@link Transcriber}:
 *  1. short-circuits to `cancelled` if the signal is already aborted;
 *  2. re-verifies the model on disk FIRST and skips `model-unavailable` if invalid
 *     (AC-24 — it does NOT download; that is #131/#132's job);
 *  3. decodes the source to a 16 kHz mono WAV, propagating a typed extract skip;
 *  4. spawns whisper-cli (array argv, local-file-only, duration-scaled timeout,
 *     cancel-kills-the-child) and parses the `-oj` JSON into a typed transcript;
 *  5. maps every failure (non-zero/timed-out/cancelled child, unreadable output,
 *     no speech) to a typed skip — never a throw, so a batch never aborts (AC-20);
 *  6. always removes the scratch WAV + JSON (re-running is safe), and NEVER touches
 *     the original source (AC-14).
 */
export function createTranscriber(options: TranscriberOptions): Transcriber {
  const {
    modelPath,
    whisperCliPath,
    extractAudio,
    runWhisper = defaultRunWhisper,
    verifyModel = (): Promise<ModelVerification> => verifyModelOnDisk(modelPath),
    readJson = (path: string): Promise<string> => readFile(path, 'utf8'),
    removeFile = (path: string): Promise<void> => rm(path, { force: true }),
    language,
  } = options;

  return async (item, ctx) => {
    const signal = ctx?.signal;
    const skip = (reason: TranscribeSkipReason, message: string): TranscribeSkip => ({
      ok: false,
      id: item.id,
      reason,
      message,
    });

    if (signal?.aborted) {
      return skip('cancelled', 'cancelled before transcription started');
    }

    // (AC-24) Re-verify the model on disk BEFORE any extraction or spawn.
    const verification = await verifyModel();
    if (!verification.valid) {
      return skip('model-unavailable', `model not verified on disk: ${verification.reason}`);
    }

    // Decode → 16 kHz mono WAV (reuse #133); a typed skip propagates, never throws.
    const extracted = await extractAudio({
      sourcePath: item.sourcePath,
      durationSec: item.durationSec,
      key: item.id,
    });
    if (!extracted.ok) {
      return skip(mapExtractReason(extracted.reason), extracted.message);
    }

    const wavPath = extracted.wavPath;
    const outputPrefix = wavPath.endsWith('.wav') ? wavPath.slice(0, -'.wav'.length) : wavPath;
    const jsonPath = `${outputPrefix}.json`;

    try {
      if (signal?.aborted) {
        return skip('cancelled', 'cancelled before whisper-cli started');
      }
      const args = buildWhisperArgs({
        modelPath,
        wavPath,
        outputPrefix,
        language: item.language ?? language,
      });
      const timeoutMs = transcribeTimeoutMs(item.durationSec);
      try {
        await runWhisper(whisperCliPath, args, { timeoutMs, signal });
      } catch (error) {
        if (error instanceof WhisperRunError) {
          const reason: TranscribeSkipReason = error.cancelled
            ? 'cancelled'
            : error.timedOut
              ? 'whisper-timed-out'
              : 'whisper-failed';
          return skip(reason, error.message);
        }
        throw error;
      }

      let transcript: Transcript;
      try {
        const rawJson = await readJson(jsonPath);
        transcript = parseWhisperJson(JSON.parse(rawJson) as WhisperJson);
      } catch (error) {
        return skip('whisper-failed', `could not read whisper-cli output: ${errorMessage(error)}`);
      }

      if (transcript.text.length === 0) {
        return skip('no-speech', 'whisper-cli produced no speech');
      }
      return { ok: true, id: item.id, transcript };
    } catch (error) {
      // A contract violation (e.g. a non-local path) — a typed skip, never a throw.
      return skip('whisper-failed', errorMessage(error));
    } finally {
      await safeRemove(removeFile, wavPath);
      await safeRemove(removeFile, jsonPath);
    }
  };
}
