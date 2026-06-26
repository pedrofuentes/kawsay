// The `transcription:start` / `:status` / `:cancel` IPC handler logic (M2, #157).
// Each is a thin, pure delegate over the run controller (the orchestrator in prod),
// re-validating its result against the contract schema before it crosses back to
// the renderer — symmetric with the model-download handlers. The controller is a
// narrowed structural subset of the orchestrator, so these unit-test with a fake
// and no thread/DB/Electron runtime; production wiring lives in index.ts.

import {
  TRANSCRIPTION_CANCEL,
  TRANSCRIPTION_START,
  TRANSCRIPTION_STATUS,
  ipcContract,
  type IpcResponse,
} from '@shared/ipc/contract';
import type { TranscriptionSnapshotDTO, TranscriptionStartResultDTO } from '@shared/ipc/schemas';

/**
 * The run capability the handlers drive — the orchestrator's renderer-facing
 * surface, narrowed so the handlers stay pure. `start` is gated + idempotent and
 * resolves with a typed result; `status` is a synchronous snapshot; `cancel`
 * reports whether a run was in flight.
 */
export interface TranscriptionRunController {
  start(): Promise<TranscriptionStartResultDTO>;
  cancel(): { cancelled: boolean };
  status(): TranscriptionSnapshotDTO;
}

export interface TranscriptionRunHandlerDeps {
  readonly controller: TranscriptionRunController;
}

/**
 * `transcription:start` handler logic. Delegates to the gated, idempotent
 * orchestrator and returns its validated result (`started` / `idle` / `refused`
 * with a typed reason + counts). Never throws on a gated refusal — the renderer
 * branches on the typed outcome, calmly.
 */
export async function handleStartTranscription(
  deps: TranscriptionRunHandlerDeps,
): Promise<IpcResponse<typeof TRANSCRIPTION_START>> {
  const result = await deps.controller.start();
  return ipcContract[TRANSCRIPTION_START].response.parse(result);
}

/**
 * `transcription:status` handler logic: report the current run snapshot
 * (idle/running/complete + counts + last settled item) so the UI can reflect it
 * on launch and during a run.
 */
export function handleTranscriptionStatus(
  deps: TranscriptionRunHandlerDeps,
): IpcResponse<typeof TRANSCRIPTION_STATUS> {
  return ipcContract[TRANSCRIPTION_STATUS].response.parse(deps.controller.status());
}

/**
 * `transcription:cancel` handler logic: cooperatively cancel the in-flight run and
 * report whether one was actually running (false is a calm no-op).
 */
export function handleCancelTranscription(
  deps: TranscriptionRunHandlerDeps,
): IpcResponse<typeof TRANSCRIPTION_CANCEL> {
  return ipcContract[TRANSCRIPTION_CANCEL].response.parse(deps.controller.cancel());
}
