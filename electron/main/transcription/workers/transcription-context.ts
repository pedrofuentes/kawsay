// Worker-side composition of the heavy per-batch collaborators (AC-18). This is the
// thin glue the off-thread worker runs to assemble the REAL audio extractor and
// whisper-cli executor from a job spec — the only place the worker touches ffmpeg and
// the whisper-cli subprocess. It is kept separate from the worker's control logic
// (transcription-job.ts) so that logic stays unit-testable with a fake context, while
// this concrete wiring is exercised here and at runtime. Mirrors the F3c ingestion
// context opener.

import { createFfmpegAudioExtractor } from '../audio-extract';
import { createTranscriber } from '../transcribe';
import type { TranscriptionJobSpec } from '../queue/protocol';
import type { TranscriptionContext } from './transcription-job';

/**
 * Resolve the audio extractor (bundled ffmpeg, confined to the job's scratch dir) and
 * the whisper-cli executor (the host-resolved model + binary paths) for one batch. The
 * executor re-verifies the model on disk per item (AC-24) and never downloads. There is
 * no db handle to release, so `close` is a no-op (kept for symmetry with the harness).
 */
export function openTranscriptionContext(job: TranscriptionJobSpec): TranscriptionContext {
  const extractAudio = createFfmpegAudioExtractor({
    scratchDir: job.scratchDir,
    ffmpegPath: job.ffmpegPath,
  });
  const transcribe = createTranscriber({
    modelPath: job.modelPath,
    whisperCliPath: job.whisperCliPath,
    extractAudio,
    language: job.language,
  });
  return {
    transcribe,
    close: () => {},
  };
}
