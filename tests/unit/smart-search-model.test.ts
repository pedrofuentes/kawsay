import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  EMBED_MODEL_DOWNLOAD_REDIRECT_HOST,
  EMBED_MODEL_DOWNLOAD_URL,
  EMBED_MODEL_FILE_NAME,
  EMBED_MODEL_SHA256,
  EMBED_MODEL_SIZE_BYTES,
} from '../../electron/main/search/embed-model-source';
import {
  EMBED_MODEL_FILENAME,
  resolveEmbedModelPath,
  type ResolveEmbedFileOptions,
} from '../../electron/main/search/embed-cli';
import {
  SMART_SEARCH_CONSENT_KEY,
  SMART_SEARCH_CONSENT_LABEL,
  createEmbedModelDownloader,
  createSmartSearchConsentStore,
  createSmartSearchController,
  resolveEmbedModelDestination,
} from '../../electron/main/search/smart-search-model';
import {
  ModelDownloadError,
  type ModelDownloader,
  type ModelDownloaderOptions,
  type ModelFetcher,
} from '../../electron/main/transcription/model-download';
import type { ConsentStore, ConsentStoreFs } from '../../electron/main/transcription/consent-store';

// A packaged-app resolution pointing at an arbitrary (never-written) resources
// root. Path assertions use `join()` so they hold byte-for-byte on Windows too.
const PACKAGED: ResolveEmbedFileOptions = {
  isPackaged: true,
  resourcesPath: join('/opt', 'kawsay', 'resources'),
  projectRoot: join('/unused', 'in', 'packaged'),
  platform: 'darwin',
  arch: 'arm64',
};

/** The path resolveEmbedModelPath looks at for {@link PACKAGED}. */
const PACKAGED_DEST = join(PACKAGED.resourcesPath, 'embed', 'mac-arm64', EMBED_MODEL_FILE_NAME);

function fakeDownloader(overrides: Partial<ModelDownloader> = {}): ModelDownloader {
  return {
    downloadModel: vi.fn().mockResolvedValue({ status: 'done', path: PACKAGED_DEST }),
    isModelReady: vi.fn().mockResolvedValue(false),
    isDownloading: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

/** An in-memory ConsentStore double (no filesystem). */
function fakeConsent(initial = false): ConsentStore & { value: boolean } {
  const store = {
    value: initial,
    isOptedIn: (): boolean => store.value,
    setOptedIn: (value: boolean): void => {
      store.value = value;
    },
  };
  return store;
}

/** A fetcher that must never be invoked (constructing a downloader is inert). */
const inertFetcher: ModelFetcher = () =>
  Promise.reject(new Error('the fetcher must not be called in this test'));

describe('embed-model-source (the pinned embedder GGUF descriptor)', () => {
  it('names the exact GGUF resolveEmbedModelPath expects (no drift from seam-1)', () => {
    expect(EMBED_MODEL_FILE_NAME).toBe(EMBED_MODEL_FILENAME);
  });

  it('pins an https Kawsay GitHub Release asset URL ending in the GGUF filename', () => {
    const url = new URL(EMBED_MODEL_DOWNLOAD_URL);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('github.com');
    expect(url.pathname.startsWith('/pedrofuentes/kawsay/releases/download/')).toBe(true);
    expect(url.pathname.endsWith(`/${EMBED_MODEL_FILE_NAME}`)).toBe(true);
  });

  it('reuses the same GitHub release-assets CDN redirect host as the M2 model', () => {
    expect(EMBED_MODEL_DOWNLOAD_REDIRECT_HOST).toBe('release-assets.githubusercontent.com');
  });

  it('carries a 64-hex placeholder sha256 + a positive byte size (finalized at publish)', () => {
    expect(EMBED_MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isInteger(EMBED_MODEL_SIZE_BYTES)).toBe(true);
    expect(EMBED_MODEL_SIZE_BYTES).toBeGreaterThan(0);
  });
});

describe('resolveEmbedModelDestination (download target == resolveEmbedModelPath location)', () => {
  it('is exactly where resolveEmbedModelPath looks in a packaged app', () => {
    const dest = resolveEmbedModelDestination(PACKAGED);
    expect(dest).toBe(PACKAGED_DEST);
    // Once a file lands there, resolveEmbedModelPath resolves to that very path.
    expect(resolveEmbedModelPath({ ...PACKAGED, exists: () => true })).toBe(dest);
  });

  it('is exactly where resolveEmbedModelPath looks in dev (repo resources/ tree)', () => {
    const dev: ResolveEmbedFileOptions = {
      isPackaged: false,
      resourcesPath: join('/unused'),
      projectRoot: join('/home', 'dev', 'kawsay'),
      platform: 'win32',
      arch: 'x64',
    };
    expect(resolveEmbedModelDestination(dev)).toBe(
      join(dev.projectRoot, 'resources', 'embed', 'win-x64', EMBED_MODEL_FILE_NAME),
    );
  });

  it('computes the destination even when the model is ABSENT (resolveEmbedModelPath ⇒ null)', () => {
    // The destination is the path to download INTO, so it must be non-null BEFORE
    // the file exists — unlike resolveEmbedModelPath, which returns null when absent.
    expect(resolveEmbedModelPath({ ...PACKAGED, exists: () => false })).toBeNull();
    expect(resolveEmbedModelDestination(PACKAGED)).toBe(PACKAGED_DEST);
  });

  it('returns null for an unshipped platform/arch (nowhere to install)', () => {
    expect(resolveEmbedModelDestination({ ...PACKAGED, platform: 'linux' })).toBeNull();
    expect(resolveEmbedModelDestination({ ...PACKAGED, arch: 'ia32' })).toBeNull();
  });
});

describe('createEmbedModelDownloader (reuses the M2 downloader, pinned to the embed model)', () => {
  it('targets the resolveEmbedModelPath location with the pinned embed URL/sha/size', () => {
    let captured: ModelDownloaderOptions | undefined;
    const built = fakeDownloader();
    const onProgress = vi.fn();

    const result = createEmbedModelDownloader({
      fetcher: inertFetcher,
      resolve: PACKAGED,
      onProgress,
      createDownloader: (opts) => {
        captured = opts;
        return built;
      },
    });

    expect(result).toBe(built);
    expect(captured?.modelPath).toBe(PACKAGED_DEST);
    expect(captured?.sourceUrl).toBe(EMBED_MODEL_DOWNLOAD_URL);
    expect(captured?.expectedSha256).toBe(EMBED_MODEL_SHA256);
    expect(captured?.expectedSize).toBe(EMBED_MODEL_SIZE_BYTES);
    expect(captured?.fetcher).toBe(inertFetcher);
    expect(captured?.onProgress).toBe(onProgress);
  });

  it('returns null for an unshipped platform (no download target ⇒ stays exact FTS)', () => {
    const result = createEmbedModelDownloader({
      fetcher: inertFetcher,
      resolve: { ...PACKAGED, platform: 'linux' },
      createDownloader: () => fakeDownloader(),
    });
    expect(result).toBeNull();
  });

  it('defaults to the real createModelDownloader and issues no request at construction', () => {
    const fetcher = vi.fn(inertFetcher);
    const downloader = createEmbedModelDownloader({ fetcher, resolve: PACKAGED });
    expect(downloader).not.toBeNull();
    expect(downloader?.isDownloading()).toBe(false);
    // Building a downloader must never touch the network (zero egress).
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('createSmartSearchConsentStore (its own opt-in, independent of transcription)', () => {
  it('exposes a smart-search consent key + label distinct from transcription', () => {
    expect(SMART_SEARCH_CONSENT_KEY).toBe('smartSearchOptedIn');
    expect(SMART_SEARCH_CONSENT_LABEL).toBe('smart search');
    expect(SMART_SEARCH_CONSENT_KEY).not.toBe('transcriptionOptedIn');
  });

  it('defaults OFF and persists under its OWN key (not the transcription key)', () => {
    const files = new Map<string, string>();
    const fs: ConsentStoreFs = {
      readFileSync: (path) => {
        const value = files.get(path);
        if (value === undefined) {
          const error = new Error('ENOENT') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
        return value;
      },
      writeFileSync: (path, data) => {
        files.set(path, String(data));
      },
      mkdirSync: () => undefined,
    };
    const filePath = join('/userData', 'smart-search-consent.json');
    const store = createSmartSearchConsentStore({ filePath, fs });

    expect(store.isOptedIn()).toBe(false); // calm default: opted OUT
    store.setOptedIn(true);
    expect(store.isOptedIn()).toBe(true);
    expect(files.get(filePath)).toContain('smartSearchOptedIn');
    expect(files.get(filePath)).not.toContain('transcriptionOptedIn');
  });
});

describe('createSmartSearchController (consent-gated, main-process enable/status port)', () => {
  it('defaults to opted-OUT and downloads NOTHING until explicitly enabled', async () => {
    const consent = fakeConsent(false);
    const downloader = fakeDownloader();
    const controller = createSmartSearchController({ consent, downloader });

    expect(await controller.status()).toEqual({ optedIn: false, modelReady: false });
    expect(downloader.downloadModel).not.toHaveBeenCalled();
  });

  it('enable() records consent THEN kicks off the embed-model download', async () => {
    const consent = fakeConsent(false);
    const downloader = fakeDownloader({ isModelReady: vi.fn().mockResolvedValue(false) });
    const controller = createSmartSearchController({ consent, downloader });

    await expect(controller.enable()).resolves.toEqual({ outcome: 'download-started' });
    expect(consent.isOptedIn()).toBe(true);
    expect(downloader.downloadModel).toHaveBeenCalledTimes(1);
  });

  it('enable() when the verified model is already present starts NO download', async () => {
    const consent = fakeConsent(false);
    const downloader = fakeDownloader({ isModelReady: vi.fn().mockResolvedValue(true) });
    const controller = createSmartSearchController({ consent, downloader });

    await expect(controller.enable()).resolves.toEqual({ outcome: 'already-present' });
    expect(consent.isOptedIn()).toBe(true);
    expect(downloader.downloadModel).not.toHaveBeenCalled();
  });

  it('enable() on an unshipped platform (no downloader) records consent but installs nothing', async () => {
    const consent = fakeConsent(false);
    const controller = createSmartSearchController({ consent, downloader: null });

    await expect(controller.enable()).resolves.toEqual({ outcome: 'unsupported-platform' });
    expect(consent.isOptedIn()).toBe(true);
    expect((await controller.status()).modelReady).toBe(false);
  });

  it('status.modelReady reflects the downloader verification (→ embedder AVAILABLE)', async () => {
    const consent = fakeConsent(true);
    const downloader = fakeDownloader({ isModelReady: vi.fn().mockResolvedValue(true) });
    const controller = createSmartSearchController({ consent, downloader });

    expect(await controller.status()).toEqual({ optedIn: true, modelReady: true });
  });

  it('disable() persists an explicit opt-out (it does not delete an installed model)', () => {
    const consent = fakeConsent(true);
    const controller = createSmartSearchController({ consent, downloader: fakeDownloader() });

    controller.disable();
    expect(consent.isOptedIn()).toBe(false);
  });

  it('a rejected (e.g. integrity-failed) download leaves the model UNAVAILABLE, without throwing', async () => {
    const consent = fakeConsent(false);
    const downloadModel = vi
      .fn()
      .mockRejectedValue(
        new ModelDownloadError('integrity', 'downloaded model failed SHA-256 verification', {
          retryable: true,
        }),
      );
    const downloader = fakeDownloader({
      downloadModel,
      isModelReady: vi.fn().mockResolvedValue(false),
    });
    const controller = createSmartSearchController({ consent, downloader });

    // enable() is fire-and-forget: a rejected download must never surface as an
    // unhandled rejection here — the model simply stays UNAVAILABLE.
    await expect(controller.enable()).resolves.toEqual({ outcome: 'download-started' });
    expect(downloadModel).toHaveBeenCalledTimes(1);
    expect((await controller.status()).modelReady).toBe(false);
  });
});
