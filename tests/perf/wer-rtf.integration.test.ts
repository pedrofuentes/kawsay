import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';
import {
  createAudioExtractor,
  createFfmpegAudioExtractor,
  type AudioExtractor,
} from '../../electron/main/transcription/audio-extract';
import { verifyModelOnDisk } from '../../electron/main/transcription/model-integrity';
import type { ModelVerification } from '../../electron/main/transcription/model-integrity';
import { resolveFfmpegPath } from '../../electron/main/importers/deps/media-binaries';
import {
  createTranscriber,
  defaultRunWhisper,
  type RunWhisper,
  type TranscribeItem,
} from '../../electron/main/transcription/transcribe';
import {
  buildMeasurement,
  formatMarkdownResults,
  parseFixtureManifest,
  summarizeMeasurements,
  wavDurationSeconds,
  type ClipMeasurement,
  type TimedTranscription,
} from './harness';
import { PERF_THRESHOLDS } from './thresholds';

// ── The REAL whisper-cli WER/RTF measurement (OPTIONAL, self-gated) ──────────
//
// This is the heavy, on-demand half of the M2 accuracy/perf harness (#137,
// ADR-0027). It transcribes the labeled fixtures with the REAL bundled
// `whisper-cli` + `small` model — invoked EXACTLY as the app does (reusing the
// #133 ffmpeg extractor, the #134 executor seams, and the same `-oj` argv) — then
// computes per-language WER (vs the ground truth) and RTF (processing ÷ audio).
//
// Like the real-whisper test in tests/unit/transcribe.test.ts, it SELF-SKIPS
// unless everything needed is present, so it NEVER blocks required CI (which has
// neither the 466 MB model nor the per-arch binary):
//   • WHISPER_CLI_PATH   → a real whisper.cpp `whisper-cli` (v1.9.1) on disk;
//   • WHISPER_MODEL_PATH → a real `ggml-small.bin` on disk;
//   • the labeled clips fetched via scripts/fetch-perf-fixtures.sh.
// Optional: KAWSAY_FFMPEG_PATH overrides the ffmpeg binary (else the staged
// per-arch ffmpeg under resources/media/); KAWSAY_PERF_RESULTS_OUT writes the
// markdown results table to that path.
//
// Run it locally with scripts/run-wer-harness.sh.

const manifestPath = fileURLToPath(new URL('./fixtures/manifest.json', import.meta.url));

function resolveEnvFile(name: string): string | null {
  const value = process.env[name];
  return value !== undefined && value.length > 0 && existsSync(value) ? value : null;
}

const whisperCli = resolveEnvFile('WHISPER_CLI_PATH');
const model = resolveEnvFile('WHISPER_MODEL_PATH');
const fixtureDir = process.env.KAWSAY_PERF_FIXTURE_DIR ?? resolve(process.cwd(), '.perf-fixtures');
const manifest = existsSync(manifestPath) ? parseFixtureManifest(readFileSync(manifestPath, 'utf8')) : null;
const fixturesPresent = manifest !== null && manifest.clips.every((clip) => existsSync(join(fixtureDir, clip.file)));

describe.skipIf(whisperCli === null || model === null || !fixturesPresent)(
  'real whisper-cli WER/RTF measurement (gated, on-demand — is `small` good enough?)',
  () => {
    it(
      'transcribes the labeled clips and meets the locked AC-21 WER + AC-18 RTF ceilings',
      async () => {
        // Unreachable when skipped; narrows the nullable env handles for the type checker.
        if (whisperCli === null || model === null || manifest === null) return;

        // Verify the model ONCE up front, then feed that result back into the
        // executor's per-spawn check — otherwise it would re-hash 466 MB for every
        // clip. A bad model fails loudly here rather than silently mis-measuring.
        const verification = await verifyModelOnDisk(model);
        expect(verification.valid, `model not verified: ${verification.reason}`).toBe(true);
        const verifyModel = (): Promise<ModelVerification> => Promise.resolve(verification);

        const scratchDir = makeTmpDir('perf-wer-');
        const ffmpegOverride = process.env.KAWSAY_FFMPEG_PATH;
        const extractAudio: AudioExtractor =
          ffmpegOverride !== undefined && ffmpegOverride.length > 0
            ? createAudioExtractor({ ffmpegPath: ffmpegOverride, scratchDir })
            : createFfmpegAudioExtractor({
                scratchDir,
                ffmpegPath: resolveFfmpegPath({
                  isPackaged: false,
                  resourcesPath: '',
                  projectRoot: process.cwd(),
                }),
              });

        // Wrap the production runner to capture inference wall-time AND the decoded
        // audio duration (read off the 16 kHz mono WAV the extractor wrote, BEFORE
        // the executor deletes it) — the RTF numerator + denominator.
        let captured: { inferenceMs: number; audioDurationSec: number } | null = null;
        const timingRunWhisper: RunWhisper = async (command, args, options) => {
          const wavPath = args[args.indexOf('-f') + 1];
          const audioDurationSec = wavDurationSeconds(await readFile(wavPath));
          const start = performance.now();
          await defaultRunWhisper(command, args, options);
          captured = { inferenceMs: performance.now() - start, audioDurationSec };
        };

        // Build the executor with the SAME seams the app uses. Language is left to
        // auto-detect (the default) so the run also exercises AC-21 multilingual
        // auto-detection across es / de / ru.
        const transcribe = createTranscriber({
          modelPath: model,
          whisperCliPath: whisperCli,
          extractAudio,
          runWhisper: timingRunWhisper,
          verifyModel,
        });

        const measurements: ClipMeasurement[] = [];
        for (const clip of manifest.clips) {
          captured = null;
          const item: TranscribeItem = { id: clip.id, sourcePath: join(fixtureDir, clip.file) };
          const result = await transcribe(item);
          const timing: { inferenceMs: number; audioDurationSec: number } = captured ?? {
            inferenceMs: 0,
            audioDurationSec: 1,
          };
          const timed: TimedTranscription = {
            result,
            inferenceMs: timing.inferenceMs,
            audioDurationSec: timing.audioDurationSec,
          };
          measurements.push(buildMeasurement(clip, timed));
        }
        removeTmpDir(scratchDir);

        const summary = summarizeMeasurements(measurements);
        const markdown = formatMarkdownResults(summary, measurements, {
          model: 'ggml-small.bin',
          binary: whisperCli,
          platform: `${process.platform}/${process.arch}`,
          generatedAt: new Date().toISOString(),
        });

        // Always surface the numbers so a local run prints them even if an
        // assertion below fails (this IS the deliverable the cofounder reads).
        console.log(`\n${markdown}\n`);
        const resultsOut = process.env.KAWSAY_PERF_RESULTS_OUT;
        if (resultsOut !== undefined && resultsOut.length > 0) writeFileSync(resultsOut, `${markdown}\n`);

        // A healthy setup transcribes every clip — no skips.
        const skips = measurements.filter((m): m is Extract<ClipMeasurement, { ok: false }> => !m.ok);
        expect(
          skips,
          `unexpected skips: ${skips.map((s) => `${s.id}:${s.reason}`).join(', ')}`,
        ).toHaveLength(0);

        // AC-21 — accuracy ceilings (aggregate corpus WER, with auto-detect ON).
        const es = summary.perLanguage.find((language) => language.language === 'es');
        expect(es, 'no Spanish clips measured').toBeDefined();
        if (es) expect(es.aggregateWer).toBeLessThanOrEqual(PERF_THRESHOLDS.werCeilingEs);
        expect(summary.overall.aggregateWer).toBeLessThanOrEqual(PERF_THRESHOLDS.werCeilingOverall);

        // AC-21 — multilingual auto-detection accuracy over the transcribed clips.
        // A per-clip exact-match assert is deliberately AVOIDED: short utterances
        // can auto-detect a close language (we measured one 3.3 s Spanish clip as
        // Italian). The floor guards the pipeline without being brittle.
        expect(summary.overall.detectionAccuracy).toBeGreaterThanOrEqual(
          PERF_THRESHOLDS.detectionAccuracyFloor,
        );

        // AC-18 — throughput: mean RTF on the measurement host (loose sanity bound).
        expect(summary.overall.meanRtf).toBeLessThanOrEqual(PERF_THRESHOLDS.rtfCeiling);
      },
      600_000,
    );
  },
);
