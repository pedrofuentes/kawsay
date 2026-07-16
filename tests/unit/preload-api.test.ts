import { describe, expect, it, vi } from 'vitest';
import { createKawsayApi } from '../../electron/preload/api';
import {
  APP_CAPABILITIES,
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
} from '@shared/ipc/contract';
import {
  CATEGORIZE_PROGRESS,
  IMPORT_PROGRESS,
  SMART_SEARCH_MODEL_DOWNLOAD_PROGRESS,
  TRANSCRIPTION_MODEL_DOWNLOAD_PROGRESS,
  TRANSCRIPTION_PROGRESS,
} from '@shared/ipc/events';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** A validated-invoke double returning a canned reply per channel. */
function fakeInvoke() {
  const calls: { channel: string; payload: unknown }[] = [];
  const replies: Record<string, unknown> = {
    [APP_GET_VERSION]: { version: '9.9.9' },
    [APP_CAPABILITIES]: {
      ffmpeg: true,
      ffprobe: true,
      clusterWorker: true,
      embedder: true,
      gazetteer: true,
    },
    [LIBRARY_CREATE]: { root: '/lib', name: 'Mum', createdAt: 't', schemaVersion: 1 },
    [LIBRARY_OPEN]: { root: '/lib', name: 'Mum', createdAt: 't', schemaVersion: 1 },
    [CATALOG_TIMELINE]: { items: [], nextCursor: null },
    [CATALOG_SEARCH]: { items: [], total: 0 },
    [IMPORT_START]: { jobId: UUID, sourceId: UUID },
    [IMPORT_CANCEL]: { cancelled: true },
    [CATALOG_UNDO_IMPORT]: { itemsRemoved: 2, occurrencesRemoved: 2 },
    [DIALOG_OPEN_DIRECTORY]: '/picked/dir',
    [DIALOG_OPEN_FILE]: '/picked/file.zip',
    [CATALOG_THUMBNAIL]: 'data:image/png;base64,AAAA',
    [TRANSCRIPTION_DOWNLOAD_MODEL]: { status: 'started' },
    [TRANSCRIPTION_MODEL_STATUS]: { ready: true },
    [SMART_SEARCH_MODEL_STATUS]: { optedIn: true, modelReady: false, offered: true },
    [SMART_SEARCH_DOWNLOAD_MODEL]: { outcome: 'download-started' },
    [TRANSCRIPTION_START]: {
      outcome: 'started',
      reason: null,
      counts: { total: 2, transcribed: 0, failed: 0, skipped: 0, inFlight: 0 },
    },
    [TRANSCRIPTION_STATUS]: {
      state: 'running',
      counts: { total: 2, transcribed: 1, failed: 0, skipped: 0, inFlight: 1 },
      lastItem: null,
    },
    [TRANSCRIPTION_CANCEL]: { cancelled: true },
    [CATALOG_GET_TRANSCRIPT]: {
      status: 'done',
      language: 'es',
      text: 'Hola, te quiero mucho.',
      segments: [{ startMs: 0, endMs: 1500, text: 'Hola, te quiero mucho.' }],
    },
    [CATALOG_SET_FAVOURITE]: { isFavourite: true },
    [CATEGORIZE_STATUS]: { optedIn: false, offered: true },
    [CATEGORIZE_SET_CONSENT]: { optedIn: true },
    [CATEGORIZE_LIST_FOR_ITEM]: [],
    [CATEGORIZE_APPLY_CORRECTION]: [],
    [CATEGORIZE_START]: {
      outcome: 'idle',
      reason: null,
      counts: { categorized: 0, skipped: 0, failed: 0, inFlight: 0 },
    },
    [CATEGORIZE_CANCEL]: { cancelled: true },
  };
  const invoke = vi.fn((channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    return Promise.resolve(replies[channel]);
  });
  return { invoke: invoke as never, calls };
}

describe('createKawsayApi (the contextBridge surface)', () => {
  it('delegates every method to its channel through the validated invoke', async () => {
    const { invoke, calls } = fakeInvoke();
    const subscribe = vi.fn(() => () => {}) as never;
    const api = createKawsayApi(invoke, subscribe);

    expect(await api.getAppVersion()).toBe('9.9.9');
    await api.createLibrary({ path: '/lib', personName: 'Mum' });
    await api.openLibrary({ path: '/lib' });
    await api.getTimeline({ limit: 50 });
    await api.searchCatalog({ query: 'beach' });
    await api.startImport({ sourceType: 'folder', inputPath: '/lib' });
    await api.cancelImport({ jobId: UUID });
    const pickedDir = await api.openDirectory({ title: 'Pick a folder' });
    const pickedFile = await api.openFile({});
    const thumbnail = await api.getThumbnail({ id: UUID });
    const modelDownload = await api.downloadTranscriptionModel();
    const modelReady = await api.isTranscriptionModelReady();
    const startRun = await api.startTranscription();
    const runStatus = await api.getTranscriptionStatus();
    const cancelRun = await api.cancelTranscription();
    const transcript = await api.getTranscript({ id: UUID });
    const favourite = await api.setFavourite({ id: UUID, favourite: true });
    const smartStatus = await api.getSmartSearchStatus();
    const smartEnable = await api.enableSmartSearch();
    const catStatus = await api.getCategorizationStatus();
    const catConsent = await api.setCategorizationConsent({ optedIn: true });
    const catList = await api.listItemCategories({ itemId: UUID });
    const catCorrection = await api.applyCategoryCorrection({
      kind: 'confirm',
      itemId: UUID,
      categoryId: UUID,
    });
    const catStart = await api.startCategorization();
    const catCancel = await api.cancelCategorization();
    // Appended last so the ordered channel/payload indices above are unshifted (#429, #441).
    const undone = await api.undoImport({ sourceId: UUID });
    const capabilities = await api.getCapabilities();

    expect(undone).toEqual({ itemsRemoved: 2, occurrencesRemoved: 2 });
    expect(capabilities).toEqual({
      ffmpeg: true,
      ffprobe: true,
      clusterWorker: true,
      embedder: true,
      gazetteer: true,
    });
    expect(pickedDir).toBe('/picked/dir');
    expect(pickedFile).toBe('/picked/file.zip');
    expect(thumbnail).toBe('data:image/png;base64,AAAA');
    expect(modelDownload).toEqual({ status: 'started' });
    expect(modelReady).toBe(true);
    expect(startRun).toEqual({
      outcome: 'started',
      reason: null,
      counts: { total: 2, transcribed: 0, failed: 0, skipped: 0, inFlight: 0 },
    });
    expect(runStatus.state).toBe('running');
    expect(cancelRun).toEqual({ cancelled: true });
    expect(transcript).toEqual({
      status: 'done',
      language: 'es',
      text: 'Hola, te quiero mucho.',
      segments: [{ startMs: 0, endMs: 1500, text: 'Hola, te quiero mucho.' }],
    });
    expect(favourite).toEqual({ isFavourite: true });
    expect(smartStatus).toEqual({ optedIn: true, modelReady: false, offered: true });
    expect(smartEnable).toEqual({ outcome: 'download-started' });
    expect(catStatus).toEqual({ optedIn: false, offered: true });
    expect(catConsent).toEqual({ optedIn: true });
    expect(catList).toEqual([]);
    expect(catCorrection).toEqual([]);
    expect(catStart).toEqual({
      outcome: 'idle',
      reason: null,
      counts: { categorized: 0, skipped: 0, failed: 0, inFlight: 0 },
    });
    expect(catCancel).toEqual({ cancelled: true });
    expect(calls.map((c) => c.channel)).toEqual([
      APP_GET_VERSION,
      LIBRARY_CREATE,
      LIBRARY_OPEN,
      CATALOG_TIMELINE,
      CATALOG_SEARCH,
      IMPORT_START,
      IMPORT_CANCEL,
      DIALOG_OPEN_DIRECTORY,
      DIALOG_OPEN_FILE,
      CATALOG_THUMBNAIL,
      TRANSCRIPTION_DOWNLOAD_MODEL,
      TRANSCRIPTION_MODEL_STATUS,
      TRANSCRIPTION_START,
      TRANSCRIPTION_STATUS,
      TRANSCRIPTION_CANCEL,
      CATALOG_GET_TRANSCRIPT,
      CATALOG_SET_FAVOURITE,
      SMART_SEARCH_MODEL_STATUS,
      SMART_SEARCH_DOWNLOAD_MODEL,
      CATEGORIZE_STATUS,
      CATEGORIZE_SET_CONSENT,
      CATEGORIZE_LIST_FOR_ITEM,
      CATEGORIZE_APPLY_CORRECTION,
      CATEGORIZE_START,
      CATEGORIZE_CANCEL,
      CATALOG_UNDO_IMPORT,
      APP_CAPABILITIES,
    ]);
    expect(calls[1].payload).toEqual({ path: '/lib', personName: 'Mum' });
    expect(calls[7].payload).toEqual({ title: 'Pick a folder' });
    expect(calls[8].payload).toEqual({});
    expect(calls[9].payload).toEqual({ id: UUID });
    expect(calls[10].payload).toEqual({});
    expect(calls[11].payload).toEqual({});
    expect(calls[12].payload).toEqual({});
    expect(calls[13].payload).toEqual({});
    expect(calls[14].payload).toEqual({});
    expect(calls[15].payload).toEqual({ id: UUID });
    expect(calls[16].payload).toEqual({ id: UUID, favourite: true });
    expect(calls[17].payload).toEqual({});
    expect(calls[18].payload).toEqual({});
    expect(calls[19].payload).toEqual({});
    expect(calls[20].payload).toEqual({ optedIn: true });
    expect(calls[21].payload).toEqual({ itemId: UUID });
    expect(calls[22].payload).toEqual({ kind: 'confirm', itemId: UUID, categoryId: UUID });
    expect(calls[23].payload).toEqual({});
    expect(calls[24].payload).toEqual({});
    expect(calls[25].payload).toEqual({ sourceId: UUID });
  });

  it('maps each suggestions method to its exact channel and payload (#351 #7)', async () => {
    // The typed surface pins channel + payload TYPES; this pins the runtime WIRING
    // string-for-string, so a mis-routed suggestions method (e.g. accept → the list
    // channel) is caught here rather than only by an end-to-end test.
    const { invoke, calls } = fakeInvoke();
    const api = createKawsayApi(invoke, vi.fn(() => () => {}) as never);

    await api.listSuggestions();
    await api.acceptSuggestion({ categoryId: UUID, name: 'Cusco, Perú' });
    await api.mergeSuggestion({ categoryId: UUID, intoCollectionId: UUID });
    await api.dismissSuggestion({ categoryId: UUID });

    expect(calls.map((c) => c.channel)).toEqual([
      SUGGESTIONS_LIST,
      SUGGESTIONS_ACCEPT,
      SUGGESTIONS_MERGE,
      SUGGESTIONS_DISMISS,
    ]);
    expect(calls[0].payload).toEqual({});
    expect(calls[1].payload).toEqual({ categoryId: UUID, name: 'Cusco, Perú' });
    expect(calls[2].payload).toEqual({ categoryId: UUID, intoCollectionId: UUID });
    expect(calls[3].payload).toEqual({ categoryId: UUID });
  });

  it('wires onModelDownloadProgress onto the model-download event subscription', () => {
    const { invoke } = fakeInvoke();
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe) as never;
    const api = createKawsayApi(invoke, subscribe);
    const listener = () => {};

    const returned = api.onModelDownloadProgress(listener);

    expect(subscribe).toHaveBeenCalledWith(TRANSCRIPTION_MODEL_DOWNLOAD_PROGRESS, listener);
    expect(returned).toBe(unsubscribe);
  });

  it('wires onSmartSearchModelDownloadProgress onto the smart-search model-download event subscription', () => {
    const { invoke } = fakeInvoke();
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe) as never;
    const api = createKawsayApi(invoke, subscribe);
    const listener = () => {};

    const returned = api.onSmartSearchModelDownloadProgress(listener);

    expect(subscribe).toHaveBeenCalledWith(SMART_SEARCH_MODEL_DOWNLOAD_PROGRESS, listener);
    expect(returned).toBe(unsubscribe);
  });

  it('wires onImportProgress onto the import:progress event subscription', () => {
    const { invoke } = fakeInvoke();
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe) as never;
    const api = createKawsayApi(invoke, subscribe);
    const listener = () => {};

    const returned = api.onImportProgress(listener);

    expect(subscribe).toHaveBeenCalledWith(IMPORT_PROGRESS, listener);
    expect(returned).toBe(unsubscribe);
  });

  it('wires onTranscriptionProgress onto the transcription:progress event subscription (#157)', () => {
    const { invoke } = fakeInvoke();
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe) as never;
    const api = createKawsayApi(invoke, subscribe);
    const listener = () => {};

    const returned = api.onTranscriptionProgress(listener);

    expect(subscribe).toHaveBeenCalledWith(TRANSCRIPTION_PROGRESS, listener);
    expect(returned).toBe(unsubscribe);
  });

  it('wires onCategorizationProgress onto the categorize:progress event subscription (#270)', () => {
    const { invoke } = fakeInvoke();
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe) as never;
    const api = createKawsayApi(invoke, subscribe);
    const listener = () => {};

    const returned = api.onCategorizationProgress(listener);

    expect(subscribe).toHaveBeenCalledWith(CATEGORIZE_PROGRESS, listener);
    expect(returned).toBe(unsubscribe);
  });

  it('exposes ONLY the typed methods — no Node primitives leak through the bridge', () => {
    const { invoke } = fakeInvoke();
    const api = createKawsayApi(invoke, vi.fn(() => () => {}) as never);

    expect(Object.keys(api).sort()).toEqual(
      [
        'acceptSuggestion',
        'applyCategoryCorrection',
        'cancelCategorization',
        'cancelImport',
        'cancelTranscription',
        'createLibrary',
        'dismissSuggestion',
        'downloadTranscriptionModel',
        'enableSmartSearch',
        'getAppVersion',
        'getCapabilities',
        'getCategorizationStatus',
        'getCollection',
        'getSettings',
        'getSmartSearchStatus',
        'getThumbnail',
        'getTimeline',
        'getTranscript',
        'getTranscriptionStatus',
        'isTranscriptionModelReady',
        'listCollections',
        'listItemCategories',
        'listSuggestions',
        'mergeSuggestion',
        'onCategorizationProgress',
        'onImportProgress',
        'onModelDownloadProgress',
        'onSmartSearchModelDownloadProgress',
        'onTranscriptionProgress',
        'openDirectory',
        'openFile',
        'openLibrary',
        'searchCatalog',
        'setCategorizationConsent',
        'setFavourite',
        'setSettings',
        'startCategorization',
        'startImport',
        'startTranscription',
        'undoImport',
      ].sort(),
    );
    // No catch-all transport or Node escape hatch is reachable from the renderer.
    const surface = api as unknown as Record<string, unknown>;
    expect(surface.require).toBeUndefined();
    expect(surface.ipcRenderer).toBeUndefined();
    expect(surface.send).toBeUndefined();
    expect(surface.invoke).toBeUndefined();
    expect(Object.values(api).every((value) => typeof value === 'function')).toBe(true);
  });

  // #437 — the Collections browser view's two READ-ONLY channels: list every
  // browsable collection, and fetch one collection's offset-paginated members.
  // Both use the literal channel string (not an imported contract constant) so
  // this test exercises the RUNTIME wiring independently of the contract module.
  it('routes listCollections/getCollection to their catalog:* channels with the right payload', async () => {
    const calls: { channel: string; payload: unknown }[] = [];
    const invoke = vi.fn((channel: string, payload: unknown) => {
      calls.push({ channel, payload });
      if (channel === 'catalog:listCollections') {
        return Promise.resolve({ collections: [] });
      }
      if (channel === 'catalog:getCollection') {
        return Promise.resolve({
          collection: { id: UUID, name: 'A summer by the lake', itemCount: 0, coverItemId: null },
          items: [],
          total: 0,
        });
      }
      return Promise.reject(new Error(`unexpected channel: ${channel}`));
    }) as never;
    const api = createKawsayApi(invoke, vi.fn(() => () => {}) as never);

    const list = await api.listCollections();
    const page = await api.getCollection({ id: UUID, limit: 50, offset: 0 });

    expect(list).toEqual({ collections: [] });
    expect(page.collection).toMatchObject({ id: UUID, name: 'A summer by the lake' });
    expect(calls).toEqual([
      { channel: 'catalog:listCollections', payload: {} },
      { channel: 'catalog:getCollection', payload: { id: UUID, limit: 50, offset: 0 } },
    ]);
  });
});
