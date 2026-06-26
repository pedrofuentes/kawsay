// Main → renderer event contract (one-way `webContents.send` streams).
//
// Unlike the request/response `ipcContract`, events flow in a single direction,
// so each channel declares ONE payload schema. The main-process event sender
// validates before `send` and the preload subscriber re-validates on receipt,
// dropping any payload that fails — so a malformed event can never reach React.

import { z } from 'zod';
import { importSummarySchema } from './schemas';

/** IPC event: streamed ingestion progress for an in-flight import. */
export const IMPORT_PROGRESS = 'import:progress';

/**
 * Lifecycle phases for an import. `discover|parse|normalize|emit` mirror the
 * engine's `ImportProgress.phase`; `done` is the synthetic terminal tick the
 * worker emits exactly once, carrying either `summary` (success / cooperative
 * cancel) or `error` (failed before producing a summary).
 */
export const IMPORT_PROGRESS_PHASES = ['discover', 'parse', 'normalize', 'emit', 'done'] as const;

/**
 * The single payload for {@link IMPORT_PROGRESS}. Terminal state is folded into
 * the same stream (phase `done`) rather than split across extra channels, so a
 * subscriber sees one ordered sequence per `jobId`.
 */
export const importProgressEventSchema = z.strictObject({
  jobId: z.uuid(),
  phase: z.enum(IMPORT_PROGRESS_PHASES),
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().nullable(),
  message: z.string().nullable(),
  summary: importSummarySchema.nullable(),
  error: z.string().nullable(),
});
export type ImportProgressEvent = z.infer<typeof importProgressEventSchema>;

/** IPC event: streamed progress for the opt-in transcription-model download. */
export const TRANSCRIPTION_MODEL_DOWNLOAD_PROGRESS = 'transcription:modelDownloadProgress';

/**
 * Lifecycle phases for the model download, mirroring the download manager's
 * `ModelDownloadProgress.phase`. `downloading` ticks carry advancing byte counts;
 * `verifying` is the SHA-256 + size check of the completed file; `done` /
 * `already-present` / `error` are the terminal states (the stream ends there).
 */
export const MODEL_DOWNLOAD_PHASES = [
  'downloading',
  'verifying',
  'done',
  'already-present',
  'error',
] as const;

/** Typed failure categories the renderer may branch on (calm, never a crash). */
export const MODEL_DOWNLOAD_ERROR_KINDS = ['network', 'disk', 'integrity', 'http'] as const;

/**
 * The single payload for {@link TRANSCRIPTION_MODEL_DOWNLOAD_PROGRESS}. Terminal
 * state is folded into the same stream (phase `done`/`already-present`/`error`)
 * so a subscriber sees one ordered sequence. `error` is non-null ONLY on the
 * `error` phase and carries a typed `kind` plus whether a retry may help.
 */
export const modelDownloadProgressEventSchema = z.strictObject({
  phase: z.enum(MODEL_DOWNLOAD_PHASES),
  bytesDownloaded: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  error: z
    .strictObject({
      kind: z.enum(MODEL_DOWNLOAD_ERROR_KINDS),
      message: z.string(),
      retryable: z.boolean(),
    })
    .nullable(),
});
export type ModelDownloadProgressEvent = z.infer<typeof modelDownloadProgressEventSchema>;

/** The complete one-way event contract. */
export const ipcEventContract = {
  [IMPORT_PROGRESS]: importProgressEventSchema,
  [TRANSCRIPTION_MODEL_DOWNLOAD_PROGRESS]: modelDownloadProgressEventSchema,
} as const;

export type IpcEventContract = typeof ipcEventContract;
export type IpcEventChannel = keyof IpcEventContract & string;
export type IpcEventPayload<C extends IpcEventChannel> = z.output<IpcEventContract[C]>;
