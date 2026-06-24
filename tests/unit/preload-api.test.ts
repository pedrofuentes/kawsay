import { describe, expect, it, vi } from 'vitest';
import { createKawsayApi } from '../../electron/preload/api';
import {
  APP_GET_VERSION,
  CATALOG_SEARCH,
  CATALOG_TIMELINE,
  IMPORT_CANCEL,
  IMPORT_START,
  LIBRARY_CREATE,
  LIBRARY_OPEN,
} from '@shared/ipc/contract';
import { IMPORT_PROGRESS } from '@shared/ipc/events';

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

    expect(calls.map((c) => c.channel)).toEqual([
      APP_GET_VERSION,
      LIBRARY_CREATE,
      LIBRARY_OPEN,
      CATALOG_TIMELINE,
      CATALOG_SEARCH,
      IMPORT_START,
      IMPORT_CANCEL,
    ]);
    expect(calls[1].payload).toEqual({ path: '/lib', personName: 'Mum' });
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

  it('exposes ONLY the typed methods — no Node primitives leak through the bridge', () => {
    const { invoke } = fakeInvoke();
    const api = createKawsayApi(invoke, vi.fn(() => () => {}) as never);

    expect(Object.keys(api).sort()).toEqual(
      [
        'cancelImport',
        'createLibrary',
        'getAppVersion',
        'getTimeline',
        'onImportProgress',
        'openLibrary',
        'searchCatalog',
        'startImport',
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
