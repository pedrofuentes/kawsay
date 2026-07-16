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
  CATALOG_SET_FAVOURITE,
  CATALOG_THUMBNAIL,
  CATALOG_TIMELINE,
  CATALOG_UNDO_IMPORT,
  CATEGORIZE_APPLY_CORRECTION,
  CATEGORIZE_CANCEL,
  CATEGORIZE_LIST_FOR_ITEM,
  CATEGORIZE_SET_CONSENT,
  CATEGORIZE_START,
  CATEGORIZE_STATUS,
  DIALOG_OPEN_DIRECTORY,
  DIALOG_OPEN_FILE,
  IMPORT_CANCEL,
  IMPORT_START,
  LIBRARY_CREATE,
  LIBRARY_OPEN,
  SETTINGS_GET,
  SETTINGS_SET,
  SMART_SEARCH_DOWNLOAD_MODEL,
  SMART_SEARCH_MODEL_STATUS,
  SUGGESTIONS_ACCEPT,
  SUGGESTIONS_DISMISS,
  SUGGESTIONS_LIST,
  SUGGESTIONS_MERGE,
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
  CATEGORIZE_PROGRESS,
  IMPORT_PROGRESS,
  SMART_SEARCH_MODEL_DOWNLOAD_PROGRESS,
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

export function createKawsayApi(invoke: ValidatedInvoke, subscribe: ValidatedSubscribe): KawsayAPI {
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
    setFavourite: (input) => invoke(CATALOG_SET_FAVOURITE, input),
    startImport: (input) => invoke(IMPORT_START, input),
    cancelImport: (input) => invoke(IMPORT_CANCEL, input),
    undoImport: (input) => invoke(CATALOG_UNDO_IMPORT, input),
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
    getSmartSearchStatus: () => invoke(SMART_SEARCH_MODEL_STATUS, {}),
    enableSmartSearch: () => invoke(SMART_SEARCH_DOWNLOAD_MODEL, {}),
    onSmartSearchModelDownloadProgress: (listener) =>
      subscribe(SMART_SEARCH_MODEL_DOWNLOAD_PROGRESS, listener),
    getCategorizationStatus: () => invoke(CATEGORIZE_STATUS, {}),
    setCategorizationConsent: (input) => invoke(CATEGORIZE_SET_CONSENT, input),
    listItemCategories: (input) => invoke(CATEGORIZE_LIST_FOR_ITEM, input),
    applyCategoryCorrection: (input) => invoke(CATEGORIZE_APPLY_CORRECTION, input),
    startCategorization: () => invoke(CATEGORIZE_START, {}),
    cancelCategorization: () => invoke(CATEGORIZE_CANCEL, {}),
    onCategorizationProgress: (listener) => subscribe(CATEGORIZE_PROGRESS, listener),

    listSuggestions: () => invoke(SUGGESTIONS_LIST, {}),
    acceptSuggestion: (input) => invoke(SUGGESTIONS_ACCEPT, input),
    mergeSuggestion: (input) => invoke(SUGGESTIONS_MERGE, input),
    dismissSuggestion: (input) => invoke(SUGGESTIONS_DISMISS, input),

    getSettings: () => invoke(SETTINGS_GET, {}),
    setSettings: (input) => invoke(SETTINGS_SET, input),
  };
}
