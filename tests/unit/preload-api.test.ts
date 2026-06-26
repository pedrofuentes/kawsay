import { describe, expect, it, vi } from 'vitest';
import { createKawsayApi } from '../../electron/preload/api';
import {
  APP_GET_VERSION,
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
} from '@shared/ipc/contract';
import {
  IMPORT_PROGRESS,
  TRANSCRIPTION_MODEL_DOWNLOAD_PROGRESS,
  TRANSCRIPTION_PROGRESS,
} from '@shared/ipc/events';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** A validated-invoke double returning a canned reply per channel. */
function fakeInvoke() {
  const calls: { channel: string; payload: unknown }[] = [];
  const replies: Record<string, unknown> = {
    [APP_GET_VERSION]: { version: '9.9.9' },
    [LIBRARY_CREATE]: { root: '/lib', name: 'Mum', createdAt: 't', schemaVersion: 1 },
    [LIBRARY_OPEN]: { root: '/lib', name: 'Mum', createdAt: 't', schemaVersion: 1 },
    [CATALOG_TIMELINE]: { items: [], nextCursor: null },
    [CATALOG_SEARCH]: { items: [], total: 0 },
    [IMPORT_START]: { jobId: UUID },
    [IMPORT_CANCEL]: { cancelled: true },
    [DIALOG_OPEN_DIRECTORY]: '/picked/dir',
    [DIALOG_OPEN_FILE]: '/picked/file.zip',
    [CATALOG_THUMBNAIL]: 'data:image/png;base64,AAAA',
    [TRANSCRIPTION_DOWNLOAD_MODEL]: { status: 'started' },
    [TRANSCRIPTION_MODEL_STATUS]: { ready: true },
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

  it('exposes ONLY the typed methods — no Node primitives leak through the bridge', () => {
    const { invoke } = fakeInvoke();
    const api = createKawsayApi(invoke, vi.fn(() => () => {}) as never);

    expect(Object.keys(api).sort()).toEqual(
      [
        'cancelImport',
        'cancelTranscription',
        'createLibrary',
        'downloadTranscriptionModel',
        'getAppVersion',
        'getThumbnail',
        'getTimeline',
        'getTranscriptionStatus',
        'isTranscriptionModelReady',
        'onImportProgress',
        'onModelDownloadProgress',
        'onTranscriptionProgress',
        'openDirectory',
        'openFile',
        'openLibrary',
        'searchCatalog',
        'startImport',
        'startTranscription',
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
});
