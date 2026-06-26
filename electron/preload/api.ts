// Assembles the renderer-facing {@link KawsayAPI} object that the preload bridge
// exposes on `window.kawsayAPI`. Every method is a thin, typed delegate over the
// validated `invoke`/`subscribe` helpers — there is NO catch-all transport and
// no Node/Electron handle on the surface, so the sandboxed renderer can reach
// exactly these capabilities and nothing more (ARCHITECTURE §1.3, §2.3). Both
// helpers are injected, so the whole surface is unit-testable without Electron.

import {
  APP_GET_VERSION,
  CATALOG_GET_TRANSCRIPT,
  CATALOG_SEARCH,
  CATALOG_THUMBNAIL,
  CATALOG_TIMELINE,
  DIALOG_OPEN_DIRECTORY,
  DIALOG_OPEN_FILE,
  IMPORT_CANCEL,
  IMPORT_START,
  LIBRARY_CREATE,
  LIBRARY_OPEN,
  TRANSCRIPTION_CANCEL,
  TRANSCRIPTION_DOWNLOAD_MODEL,
  TRANSCRIPTION_MODEL_STATUS,
  TRANSCRIPTION_START,
  TRANSCRIPTION_STATUS,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
} from '@shared/ipc/contract';
import {
  IMPORT_PROGRESS,
  TRANSCRIPTION_MODEL_DOWNLOAD_PROGRESS,
  TRANSCRIPTION_PROGRESS,
  type IpcEventChannel,
  type IpcEventPayload,
} from '@shared/ipc/events';
import type { KawsayAPI } from '@shared/kawsay-api';

/** The validated invoke helper (request/response zod-checked across the boundary). */
export type ValidatedInvoke = <C extends IpcChannel>(
  channel: C,
  payload: IpcRequest<C>,
) => Promise<IpcResponse<C>>;

/** The validated event subscription helper (payload zod-checked on receipt). */
export type ValidatedSubscribe = <C extends IpcEventChannel>(
  channel: C,
  listener: (payload: IpcEventPayload<C>) => void,
) => () => void;

export function createKawsayApi(
  invoke: ValidatedInvoke,
  subscribe: ValidatedSubscribe,
): KawsayAPI {
  return {
    async getAppVersion() {
      const { version } = await invoke(APP_GET_VERSION, {});
      return version;
    },
    createLibrary: (input) => invoke(LIBRARY_CREATE, input),
    openLibrary: (input) => invoke(LIBRARY_OPEN, input),
    getTimeline: (input) => invoke(CATALOG_TIMELINE, input),
    searchCatalog: (input) => invoke(CATALOG_SEARCH, input),
    getThumbnail: (input) => invoke(CATALOG_THUMBNAIL, input),
    getTranscript: (input) => invoke(CATALOG_GET_TRANSCRIPT, input),
    startImport: (input) => invoke(IMPORT_START, input),
    cancelImport: (input) => invoke(IMPORT_CANCEL, input),
    openDirectory: (options) => invoke(DIALOG_OPEN_DIRECTORY, options ?? {}),
    openFile: (options) => invoke(DIALOG_OPEN_FILE, options ?? {}),
    onImportProgress: (listener) => subscribe(IMPORT_PROGRESS, listener),
    downloadTranscriptionModel: () => invoke(TRANSCRIPTION_DOWNLOAD_MODEL, {}),
    async isTranscriptionModelReady() {
      const { ready } = await invoke(TRANSCRIPTION_MODEL_STATUS, {});
      return ready;
    },
    onModelDownloadProgress: (listener) =>
      subscribe(TRANSCRIPTION_MODEL_DOWNLOAD_PROGRESS, listener),
    startTranscription: () => invoke(TRANSCRIPTION_START, {}),
    getTranscriptionStatus: () => invoke(TRANSCRIPTION_STATUS, {}),
    cancelTranscription: () => invoke(TRANSCRIPTION_CANCEL, {}),
    onTranscriptionProgress: (listener) => subscribe(TRANSCRIPTION_PROGRESS, listener),
  };
}
