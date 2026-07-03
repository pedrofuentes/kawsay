import { describe, expect, it, vi } from 'vitest';
import {
  handleSmartSearchEnable,
  handleSmartSearchStatus,
  type SmartSearchModelController,
} from '../../../electron/main/ipc/handlers/smart-search';
import {
  SMART_SEARCH_DOWNLOAD_MODEL,
  SMART_SEARCH_MODEL_STATUS,
  ipcContract,
} from '@shared/ipc/contract';
import {
  EMBED_MODEL_SHA256,
  isEmbedModelPublished,
} from '../../../electron/main/search/embed-model-source';

type EnableOutcome = 'download-started' | 'already-present' | 'unsupported-platform';

function makeController(
  over: Partial<SmartSearchModelController> = {},
): SmartSearchModelController {
  return {
    status: vi.fn(() => Promise.resolve({ optedIn: false, modelReady: false })),
    enable: vi.fn(() => Promise.resolve({ outcome: 'download-started' as EnableOutcome })),
    ...over,
  };
}

describe('smart-search model IPC handlers', () => {
  describe('handleSmartSearchStatus', () => {
    it('layers the offered gate onto the controller snapshot (offered: true)', async () => {
      const controller = makeController({
        status: vi.fn(() => Promise.resolve({ optedIn: true, modelReady: true })),
      });
      const response = await handleSmartSearchStatus({ controller, isOffered: () => true });
      expect(response).toEqual({ optedIn: true, modelReady: true, offered: true });
    });

    it('reports offered: false while the feature is not yet available', async () => {
      const controller = makeController({
        status: vi.fn(() => Promise.resolve({ optedIn: false, modelReady: false })),
      });
      const response = await handleSmartSearchStatus({ controller, isOffered: () => false });
      expect(response).toEqual({ optedIn: false, modelReady: false, offered: false });
    });

    it('reflects an opted-in user whose model is not ready yet (mid-download)', async () => {
      const controller = makeController({
        status: vi.fn(() => Promise.resolve({ optedIn: true, modelReady: false })),
      });
      const response = await handleSmartSearchStatus({ controller, isOffered: () => true });
      expect(response).toEqual({ optedIn: true, modelReady: false, offered: true });
    });

    it('returns a response that satisfies the contract zod schema', async () => {
      const controller = makeController({
        status: vi.fn(() => Promise.resolve({ optedIn: true, modelReady: false })),
      });
      const response = await handleSmartSearchStatus({ controller, isOffered: () => true });
      expect(ipcContract[SMART_SEARCH_MODEL_STATUS].response.safeParse(response).success).toBe(
        true,
      );
    });

    it('queries the controller exactly once per status call', async () => {
      const status = vi.fn(() => Promise.resolve({ optedIn: false, modelReady: false }));
      const controller = makeController({ status });
      await handleSmartSearchStatus({ controller, isOffered: () => false });
      expect(status).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleSmartSearchEnable', () => {
    for (const outcome of [
      'download-started',
      'already-present',
      'unsupported-platform',
    ] as const) {
      it(`passes through the controller "${outcome}" outcome`, async () => {
        const enable = vi.fn(() => Promise.resolve({ outcome }));
        const controller = makeController({ enable });

        const response = await handleSmartSearchEnable({ controller });

        expect(response).toEqual({ outcome });
        expect(enable).toHaveBeenCalledTimes(1);
        expect(ipcContract[SMART_SEARCH_DOWNLOAD_MODEL].response.safeParse(response).success).toBe(
          true,
        );
      });
    }

    it('is caller-initiated: building deps never auto-triggers enable', () => {
      const enable = vi.fn(() => Promise.resolve({ outcome: 'download-started' as EnableOutcome }));
      makeController({ enable });
      expect(enable).not.toHaveBeenCalled();
    });
  });
});

describe('isEmbedModelPublished (the offered-gate predicate)', () => {
  it('reports the feature published now that a real (non-sentinel) digest is pinned', () => {
    // The descriptor now carries the finalized digest of the published
    // `models-embed-v1` GGUF, so the predicate reports smart search as available.
    expect(EMBED_MODEL_SHA256).not.toBe('0'.repeat(64));
    expect(EMBED_MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(isEmbedModelPublished()).toBe(true);
  });

  it('exercises the REAL exported predicate returning true (resolves #241)', () => {
    // #241: the earlier test asserted a LOCAL copy of the comparison, which never
    // touched the real predicate. Pin the true branch on the exported function
    // itself, now that a genuine digest replaces the fail-closed all-zero sentinel.
    expect(isEmbedModelPublished()).toBe(true);
    // Documented contrast: the all-zero sentinel is NOT what is pinned anymore.
    expect(EMBED_MODEL_SHA256).not.toBe('0'.repeat(64));
  });
});
