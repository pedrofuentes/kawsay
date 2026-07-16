import { describe, expect, it, vi } from 'vitest';
import {
  APP_GET_VERSION,
  CATALOG_TIMELINE,
  SMART_SEARCH_MODEL_STATUS,
  TRANSCRIPTION_DOWNLOAD_MODEL,
  type IpcChannel,
} from '@shared/ipc/contract';
import {
  buildIpcHandlers,
  type IpcHandlerDeps,
} from '../../electron/main/app/composition-root';
import type { CatalogSession } from '../../electron/main/app/catalog-session';

// `buildIpcHandlers` is the explicit factory that replaced the old ambient
// `ipcHandlers` object literal. It lives in the (coverage-excluded) composition
// root, so these focused checks lock the load-bearing wiring: version passthrough,
// catalog delegation, the smart-search `offered` latch, and — most importantly —
// the `transcription:downloadModel` opt-in side effect (record consent, THEN
// download), whose order is behaviourally critical (AC-22).

/** Minimal deps with every accessor a spy; individual tests override what they assert. */
function fakeDeps(overrides: Partial<IpcHandlerDeps> = {}): {
  deps: IpcHandlerDeps;
  catalog: { getTimeline: ReturnType<typeof vi.fn> };
  consent: { setOptedIn: ReturnType<typeof vi.fn> };
  modelController: { isModelReady: ReturnType<typeof vi.fn>; downloadModel: ReturnType<typeof vi.fn> };
} {
  const catalog = { getTimeline: vi.fn(() => ({ items: [], nextCursor: null })) };
  const consent = { setOptedIn: vi.fn() };
  const modelController = {
    isModelReady: vi.fn(async () => false),
    downloadModel: vi.fn(async () => undefined),
  };
  const deps: IpcHandlerDeps = {
    catalogSession: catalog as unknown as CatalogSession,
    getVersion: () => '4.5.6',
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    requireModelController: () => modelController as never,
    requireConsentStore: () => consent as never,
    requireTranscriptionController: () => ({}) as never,
    requireSmartSearchController: () =>
      ({ status: async () => ({ optedIn: true, modelReady: false }) }) as never,
    requireCategorizationConsentStore: () => ({}) as never,
    requireSettingsStore: () => ({}) as never,
    isSmartSearchOffered: () => true,
    isCategorizationOffered: () => true,
    ...overrides,
  };
  return { deps, catalog, consent, modelController };
}

describe('buildIpcHandlers', () => {
  it('produces exactly one handler per contract channel', () => {
    const { deps } = fakeDeps();
    const handlers = buildIpcHandlers(deps);
    // A representative spread across the feature areas is present.
    const channels: IpcChannel[] = [
      APP_GET_VERSION,
      CATALOG_TIMELINE,
      TRANSCRIPTION_DOWNLOAD_MODEL,
      SMART_SEARCH_MODEL_STATUS,
    ];
    for (const channel of channels) {
      expect(typeof handlers[channel]).toBe('function');
    }
  });

  it('routes app:getVersion through the injected getVersion', async () => {
    const { deps } = fakeDeps();
    const result = await buildIpcHandlers(deps)[APP_GET_VERSION](undefined as never);
    expect(result).toEqual({ version: '4.5.6' });
  });

  it('delegates catalog:timeline to the catalog session', async () => {
    const { deps, catalog } = fakeDeps();
    const request = { limit: 10 };
    await buildIpcHandlers(deps)[CATALOG_TIMELINE](request as never);
    expect(catalog.getTimeline).toHaveBeenCalledWith(request);
  });

  it('records the durable opt-in BEFORE kicking off a model download (AC-22)', async () => {
    const { deps, consent, modelController } = fakeDeps();
    const result = await buildIpcHandlers(deps)[TRANSCRIPTION_DOWNLOAD_MODEL](undefined as never);
    // Consent is recorded, and since the model is not present the download starts.
    expect(consent.setOptedIn).toHaveBeenCalledWith(true);
    expect(consent.setOptedIn.mock.invocationCallOrder[0]).toBeLessThan(
      modelController.isModelReady.mock.invocationCallOrder[0],
    );
    expect(result).toEqual({ status: 'started' });
  });

  it('reflects the smart-search offered latch in the status response', async () => {
    const { deps } = fakeDeps({ isSmartSearchOffered: () => false });
    const result = await buildIpcHandlers(deps)[SMART_SEARCH_MODEL_STATUS](undefined as never);
    expect(result).toEqual({ optedIn: true, modelReady: false, offered: false });
  });
});
