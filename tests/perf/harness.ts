import { z } from 'zod';
import type { TranscribeResult } from '../../electron/main/transcription/transcribe';
import { computeWer } from './wer';

// The pure orchestration logic of the M2 offline WER/RTF harness (ADR-0027,
// PRD AC-21 accuracy + AC-18 performance). Everything here is binary-free and
// CI-runnable: it validates the labeled fixture manifest, derives audio duration
// from a decoded WAV, turns a TIMED transcription into a per-clip WER + RTF
// measurement, aggregates per-language + overall summaries, and renders the
// committed markdown results table. The heavy parts — actually decoding the clip
// with ffmpeg and transcribing it with the real `whisper-cli` + `small` model —
// live in the self-gated integration test, which feeds its timed results into
// `buildMeasurement` here. This split is exactly the AC-4 harness convention
// (pure `.ts` logic, unit-tested; the real-binary run gated by env).

// ── labeled fixture manifest (the ground-truth set) ─────────────────────────

const clipSchema = z.object({
  /** Stable, filesystem-safe id (also the extractor output stem), e.g. `es-941424`. */
  id: z.string().regex(/^[A-Za-z0-9._-]+$/),
  /** Whisper/ISO-639-1 language code of the spoken audio, e.g. `es`, `de`, `ru`. */
  language: z.string().min(1),
  /** Local filename the fetch script writes the clip to, e.g. `es_941424.mp3`. */
  file: z.string().min(1),
  /** Pinned HTTPS source URL the clip is fetched + sha256-verified from. */
  url: z.string().regex(/^https:\/\/\S+$/, 'must be an https URL'),
  /** Pinned lowercase-hex SHA-256 of the clip (fail-closed integrity, like egress). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a 64-char lowercase hex sha256'),
  /** The ground-truth transcript (the WER reference). */
  transcript: z.string().min(1),
  /** The clip's license (CC0 1.0 / CC BY 4.0 — see fixtures/NOTICES.md). */
  license: z.string().min(1),
  /** Attribution string for the recording (required by CC BY). */
  attribution: z.string().min(1),
});

const manifestSchema = z.object({
  /** Human-readable provenance, e.g. `Tatoeba (https://tatoeba.org)`. */
  source: z.string().min(1),
  /** A one-line license summary (details in fixtures/NOTICES.md). */
  license: z.string().min(1),
  /** The exact WER normalization the labels assume (kept in sync with wer.ts). */
  normalization: z.string().min(1),
  /** The labeled clips (at least one). */
  clips: z.array(clipSchema).min(1),
});

/** One labeled fixture clip. */
export type FixtureClip = z.infer<typeof clipSchema>;
/** The labeled fixture set. */
export type FixtureManifest = z.infer<typeof manifestSchema>;

/**
 * Parse + validate the fixtures manifest JSON. Throws on invalid JSON or any
 * schema violation (missing clips, a malformed sha256, a non-https url, an empty
 * ground-truth transcript) so a corrupt manifest fails loudly rather than silently
 * measuring against bad labels.
 */
export function parseFixtureManifest(jsonText: string): FixtureManifest {
  const data: unknown = JSON.parse(jsonText);
  return manifestSchema.parse(data);
}

// ── audio duration (for RTF) ────────────────────────────────────────────────

/**
 * Parse a PCM WAV's RIFF/WAVE header and return its duration in seconds from the
 * `fmt `+`data` chunks (`dataBytes / (sampleRate * channels * bytesPerSample)`).
 * The harness decodes each clip to the 16 kHz mono s16le WAV `whisper-cli`
 * consumes (via the app's own extractor), so this reads the duration off that same
 * WAV. Throws on a non-RIFF/WAVE buffer or a header missing the required chunks.
 */
export function wavDurationSeconds(wav: Buffer): number {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let sampleRate: number | null = null;
  let channels: number | null = null;
  let bitsPerSample: number | null = null;
  let dataBytes: number | null = null;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === 'fmt ' && body + 16 <= wav.length) {
      channels = wav.readUInt16LE(body + 2);
      sampleRate = wav.readUInt32LE(body + 4);
      bitsPerSample = wav.readUInt16LE(body + 14);
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }
    // RIFF chunks are word-aligned: a padding byte follows an odd-length chunk.
    offset = body + chunkSize + (chunkSize % 2);
  }
  if (sampleRate === null || channels === null || bitsPerSample === null || dataBytes === null) {
    throw new Error('WAV header missing fmt/data chunk');
  }
  const bytesPerFrame = channels * (bitsPerSample / 8);
  if (bytesPerFrame <= 0 || sampleRate <= 0) {
    throw new Error('WAV header has invalid fmt parameters');
  }
  return dataBytes / (sampleRate * bytesPerFrame);
}

// ── real-time factor ────────────────────────────────────────────────────────

/**
 * The real-time factor: processing wall-time ÷ audio duration. `< 1` is faster
 * than real time (good); `> 1` is slower than real time. Throws on a non-positive
 * / non-finite audio duration (a broken/zero-length decode the caller should skip).
 */
export function computeRtf(processingMs: number, audioDurationSec: number): number {
  if (!Number.isFinite(audioDurationSec) || audioDurationSec <= 0) {
    throw new RangeError(`audio duration must be a positive finite number, got ${audioDurationSec}`);
  }
  return processingMs / 1000 / audioDurationSec;
}

// ── per-clip measurement ────────────────────────────────────────────────────

/** A single transcription result paired with its timing + audio duration. */
export interface TimedTranscription {
  /** The app's own typed transcription result (ok transcript, or a typed skip). */
  readonly result: TranscribeResult;
  /** Wall-time of the `whisper-cli` inference (ms) — the RTF numerator. */
  readonly inferenceMs: number;
  /** Decoded audio duration (s) — the RTF denominator. */
  readonly audioDurationSec: number;
}

/** A successful per-clip measurement (WER + RTF). */
export interface ClipMeasurementOk {
  readonly ok: true;
  readonly id: string;
  readonly language: string;
  /** The language whisper auto-detected (AC-21), or null. */
  readonly detectedLanguage: string | null;
  /** The model transcript (the WER hypothesis). */
  readonly hypothesis: string;
  readonly referenceWordCount: number;
  readonly errorCount: number;
  readonly wer: number;
  readonly audioDurationSec: number;
  readonly inferenceMs: number;
  readonly rtf: number;
}

/** A skipped clip (carries the app's typed skip reason — never throws a batch). */
export interface ClipMeasurementSkip {
  readonly ok: false;
  readonly id: string;
  readonly language: string;
  readonly reason: string;
  readonly message: string;
}

/** The result of measuring one clip. */
export type ClipMeasurement = ClipMeasurementOk | ClipMeasurementSkip;

/** The label fields `buildMeasurement` needs (a {@link FixtureClip} satisfies this). */
export interface MeasurementClip {
  readonly id: string;
  readonly language: string;
  readonly transcript: string;
}

/**
 * Combine a timed transcription with the clip's ground truth into a measurement:
 * a successful transcript yields WER (vs the label) + RTF; a typed skip is carried
 * through as a non-fatal skip so one bad clip never aborts the batch (AC-20).
 */
export function buildMeasurement(clip: MeasurementClip, timed: TimedTranscription): ClipMeasurement {
  if (!timed.result.ok) {
    return {
      ok: false,
      id: clip.id,
      language: clip.language,
      reason: timed.result.reason,
      message: timed.result.message,
    };
  }
  const { transcript } = timed.result;
  const wer = computeWer(clip.transcript, transcript.text);
  return {
    ok: true,
    id: clip.id,
    language: clip.language,
    detectedLanguage: transcript.language,
    hypothesis: transcript.text,
    referenceWordCount: wer.referenceWordCount,
    errorCount: wer.errorCount,
    wer: wer.wer,
    audioDurationSec: timed.audioDurationSec,
    inferenceMs: timed.inferenceMs,
    rtf: computeRtf(timed.inferenceMs, timed.audioDurationSec),
  };
}

// ── aggregation ─────────────────────────────────────────────────────────────

/** Aggregated metrics for one language (or overall). */
export interface AggregateStats {
  readonly clipCount: number;
  readonly okCount: number;
  readonly totalReferenceWords: number;
  readonly totalErrors: number;
  /** Micro (corpus) WER = totalErrors / totalReferenceWords over ok clips. */
  readonly aggregateWer: number;
  /** Macro WER = mean of per-clip WER over ok clips. */
  readonly meanWer: number;
  /** Mean RTF over ok clips. */
  readonly meanRtf: number;
  /** Ok clips whose auto-detected language matched the labelled language (AC-21). */
  readonly detectedCount: number;
  /** detectedCount / okCount — language auto-detection accuracy (0 when no ok clips). */
  readonly detectionAccuracy: number;
}

/** Per-language aggregate (adds the language code). */
export interface LanguageSummary extends AggregateStats {
  readonly language: string;
}

/** The full harness summary: per-language rows + an overall row. */
export interface HarnessSummary {
  readonly perLanguage: LanguageSummary[];
  readonly overall: AggregateStats;
}

function aggregate(measurements: ClipMeasurement[]): AggregateStats {
  const ok = measurements.filter((m): m is ClipMeasurementOk => m.ok);
  const totalReferenceWords = ok.reduce((sum, m) => sum + m.referenceWordCount, 0);
  const totalErrors = ok.reduce((sum, m) => sum + m.errorCount, 0);
  const meanWer = ok.length > 0 ? ok.reduce((sum, m) => sum + m.wer, 0) / ok.length : 0;
  const meanRtf = ok.length > 0 ? ok.reduce((sum, m) => sum + m.rtf, 0) / ok.length : 0;
  const detectedCount = ok.filter((m) => m.detectedLanguage === m.language).length;
  return {
    clipCount: measurements.length,
    okCount: ok.length,
    totalReferenceWords,
    totalErrors,
    aggregateWer: totalReferenceWords > 0 ? totalErrors / totalReferenceWords : 0,
    meanWer,
    meanRtf,
    detectedCount,
    detectionAccuracy: ok.length > 0 ? detectedCount / ok.length : 0,
  };
}

/**
 * Summarize per-clip measurements into per-language rows (first-seen order) and an
 * overall row. Per-language and overall WER are the MICRO (corpus) WER — total
 * errors over total reference words across ok clips — with the macro mean WER and
 * mean RTF reported alongside. Skips count toward `clipCount` but not the WER.
 */
export function summarizeMeasurements(measurements: ClipMeasurement[]): HarnessSummary {
  const languages: string[] = [];
  for (const m of measurements) {
    if (!languages.includes(m.language)) languages.push(m.language);
  }
  const perLanguage = languages.map((language) => ({
    language,
    ...aggregate(measurements.filter((m) => m.language === language)),
  }));
  return { perLanguage, overall: aggregate(measurements) };
}

// ── markdown results ────────────────────────────────────────────────────────

/** Optional context printed above the results tables (model/binary/platform). */
export interface ResultsMeta {
  readonly model?: string;
  readonly binary?: string;
  readonly platform?: string;
  readonly generatedAt?: string;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Render the harness summary (and, when provided, the per-clip detail) as the
 * markdown tables committed to the results doc, so the cofounder sees real numbers.
 */
export function formatMarkdownResults(
  summary: HarnessSummary,
  measurements: ClipMeasurement[],
  meta: ResultsMeta = {},
): string {
  const lines: string[] = [];
  if (meta.model || meta.binary || meta.platform || meta.generatedAt) {
    if (meta.model) lines.push(`- **Model:** ${meta.model}`);
    if (meta.binary) lines.push(`- **Binary:** ${meta.binary}`);
    if (meta.platform) lines.push(`- **Platform:** ${meta.platform}`);
    if (meta.generatedAt) lines.push(`- **Measured:** ${meta.generatedAt}`);
    lines.push('');
  }

  lines.push('| Language | Clips | OK | Ref words | Errors | WER (aggregate) | mean WER | mean RTF | Detected |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const lang of summary.perLanguage) {
    lines.push(
      `| ${lang.language} | ${lang.clipCount} | ${lang.okCount} | ${lang.totalReferenceWords} | ` +
        `${lang.totalErrors} | ${pct(lang.aggregateWer)} | ${pct(lang.meanWer)} | ${lang.meanRtf.toFixed(2)}× | ` +
        `${lang.detectedCount}/${lang.okCount} (${pct(lang.detectionAccuracy)}) |`,
    );
  }
  const o = summary.overall;
  lines.push(
    `| **Overall** | ${o.clipCount} | ${o.okCount} | ${o.totalReferenceWords} | ${o.totalErrors} | ` +
      `**${pct(o.aggregateWer)}** | ${pct(o.meanWer)} | **${o.meanRtf.toFixed(2)}×** | ` +
      `**${o.detectedCount}/${o.okCount} (${pct(o.detectionAccuracy)})** |`,
  );

  if (measurements.length > 0) {
    lines.push('');
    lines.push('| Clip | Lang | Detected | Audio (s) | Inference (s) | RTF | WER | Errors/Words | Transcript |');
    lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const m of measurements) {
      if (m.ok) {
        lines.push(
          `| ${m.id} | ${m.language} | ${m.detectedLanguage ?? '—'} | ${m.audioDurationSec.toFixed(2)} | ` +
            `${(m.inferenceMs / 1000).toFixed(2)} | ${m.rtf.toFixed(2)}× | ${pct(m.wer)} | ` +
            `${m.errorCount}/${m.referenceWordCount} | ${m.hypothesis.replace(/\|/g, '\\|')} |`,
        );
      } else {
        lines.push(`| ${m.id} | ${m.language} | — | — | — | — | skip (${m.reason}) | — | ${m.message.replace(/\|/g, '\\|')} |`);
      }
    }
  }

  return lines.join('\n');
}
