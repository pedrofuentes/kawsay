import { describe, expect, it, vi } from 'vitest';
import {
  handleDownloadModel,
  handleModelStatus,
  type TranscriptionModelController,
} from '../../electron/main/ipc/handlers/transcription';

function makeController(
  over: Partial<TranscriptionModelController> = {},
): TranscriptionModelController {
  return {
    isModelReady: vi.fn(() => Promise.resolve(false)),
    downloadModel: vi.fn(() => Promise.resolve({ status: 'done' as const })),
    ...over,
  };
}

describe('transcription model IPC handlers', () => {
  describe('handleModelStatus', () => {
    it('reports ready: true when the model is present + verified', async () => {
      const controller = makeController({ isModelReady: vi.fn(() => Promise.resolve(true)) });
      expect(await handleModelStatus({ controller })).toEqual({ ready: true });
    });

    it('reports ready: false when the model is absent or unverified', async () => {
      const controller = makeController({ isModelReady: vi.fn(() => Promise.resolve(false)) });
      expect(await handleModelStatus({ controller })).toEqual({ ready: false });
    });
  });

  describe('handleDownloadModel', () => {
    it('returns "already-present" and does NOT start a download when the model is ready', async () => {
      const downloadModel = vi.fn(() => Promise.resolve({ status: 'done' as const }));
      const controller = makeController({
        isModelReady: vi.fn(() => Promise.resolve(true)),
        downloadModel,
      });

      expect(await handleDownloadModel({ controller })).toEqual({ status: 'already-present' });
      expect(downloadModel).not.toHaveBeenCalled();
    });

    it('starts the download (fire-and-forget) and returns "started" when not ready', async () => {
      const downloadModel = vi.fn(() => Promise.resolve({ status: 'done' as const }));
      const controller = makeController({
        isModelReady: vi.fn(() => Promise.resolve(false)),
        downloadModel,
      });

      expect(await handleDownloadModel({ controller })).toEqual({ status: 'started' });
      expect(downloadModel).toHaveBeenCalledTimes(1);
    });

    it('does not reject even if the background download fails (errors surface via the event stream)', async () => {
      const downloadModel = vi.fn(() => Promise.reject(new Error('offline')));
      const controller = makeController({
        isModelReady: vi.fn(() => Promise.resolve(false)),
        downloadModel,
      });

      // The handler resolves calmly; the rejection is swallowed here (the renderer
      // is told via the modelDownloadProgress 'error' event, not this response).
      await expect(handleDownloadModel({ controller })).resolves.toEqual({ status: 'started' });
      // Let the swallowed rejection settle so no unhandled rejection escapes.
      await Promise.resolve();
    });

    it('is caller-initiated: building deps never auto-triggers a download', () => {
      const downloadModel = vi.fn(() => Promise.resolve({ status: 'done' as const }));
      makeController({ downloadModel });
      expect(downloadModel).not.toHaveBeenCalled();
    });
  });
});
