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

/** The complete one-way event contract. */
export const ipcEventContract = {
  [IMPORT_PROGRESS]: importProgressEventSchema,
} as const;

export type IpcEventContract = typeof ipcEventContract;
export type IpcEventChannel = keyof IpcEventContract & string;
export type IpcEventPayload<C extends IpcEventChannel> = z.output<IpcEventContract[C]>;
