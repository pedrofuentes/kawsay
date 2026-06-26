import {
  TRANSCRIPTION_DOWNLOAD_MODEL,
  TRANSCRIPTION_MODEL_STATUS,
  ipcContract,
  type IpcResponse,
} from '@shared/ipc/contract';

/**
 * The model-download capability the handlers drive, narrowed to a structural
 * subset of the download manager so the handlers stay pure and unit-testable
 * without an Electron runtime (the real downloader is wired in
 * electron/main/index.ts). `downloadModel` is started fire-and-forget — its
 * progress and terminal result reach the renderer over the
 * `transcription:modelDownloadProgress` event, NOT this response.
 */
export interface TranscriptionModelController {
  /** True iff the model is present AND integrity-verified. */
  isModelReady(): Promise<boolean>;
  /** Download (or confirm) the verified model. Single-flight in the real impl. */
  downloadModel(): Promise<{ status: 'done' | 'already-present' }>;
}

export interface TranscriptionHandlerDeps {
  readonly controller: TranscriptionModelController;
}

/**
 * `transcription:downloadModel` handler logic (AC-17). Caller-initiated: this
 * runs ONLY when the renderer explicitly invokes the channel (the consent UI is
 * card #132) — it is never auto-triggered. If a verified model is already on
 * disk it reports `already-present` and starts nothing; otherwise it kicks off
 * the download fire-and-forget (progress/terminal state stream over the event
 * channel) and reports `started`. A rejected download is swallowed here because
 * the renderer is told via the `error` progress event, not this response.
 */
export async function handleDownloadModel(
  deps: TranscriptionHandlerDeps,
): Promise<IpcResponse<typeof TRANSCRIPTION_DOWNLOAD_MODEL>> {
  if (await deps.controller.isModelReady()) {
    return ipcContract[TRANSCRIPTION_DOWNLOAD_MODEL].response.parse({ status: 'already-present' });
  }
  void deps.controller.downloadModel().catch(() => undefined);
  return ipcContract[TRANSCRIPTION_DOWNLOAD_MODEL].response.parse({ status: 'started' });
}

/**
 * `transcription:modelStatus` handler logic: report whether the model is present
 * AND integrity-verified — the capability gate the UI reads.
 */
export async function handleModelStatus(
  deps: TranscriptionHandlerDeps,
): Promise<IpcResponse<typeof TRANSCRIPTION_MODEL_STATUS>> {
  return ipcContract[TRANSCRIPTION_MODEL_STATUS].response.parse({
    ready: await deps.controller.isModelReady(),
  });
}
