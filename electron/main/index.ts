import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, session } from 'electron';
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
} from '@shared/ipc/contract';
import {
  IMPORT_PROGRESS,
  TRANSCRIPTION_MODEL_DOWNLOAD_PROGRESS,
  TRANSCRIPTION_PROGRESS,
} from '@shared/ipc/events';
import { handleGetVersion } from './ipc/handlers/app';
import { handleOpenDirectory, handleOpenFile, type ShowOpenDialog } from './ipc/handlers/dialog';
import { handleDownloadModel, handleModelStatus } from './ipc/handlers/transcription';
import {
  handleCancelTranscription,
  handleStartTranscription,
  handleTranscriptionStatus,
} from './ipc/handlers/transcription-run';
import { registerIpcHandlers, type IpcHandlerMap } from './ipc/register';
import { createEventSender } from './ipc/event-sender';
import type { TrustedSenderOptions } from './ipc/sender';
import { createCatalogSession } from './app/catalog-session';
import { createIngestionCoordinator } from './importers/ingestion/coordinator';
import { createWorkerThreadsSpawner } from './importers/ingestion/worker-threads-transport';
import { createFfmpegVideoFrameThumbnailer } from './importers/deps/thumbnail';
import { resolveFfmpegPath, resolveFfprobePath } from './importers/deps/media-binaries';
import type { ImageThumbnailer, VideoThumbnailer } from './library/thumbnail-service';
import { createModelDownloader } from './transcription/model-download';
import { createElectronModelFetcher } from './transcription/electron-net-fetcher';
import { MODEL_FILE_NAME } from './transcription/model-source';
import { createConsentStore, type ConsentStore } from './transcription/consent-store';
import { createTranscriptionCoordinator } from './transcription/queue/coordinator';
import { createWorkerThreadsSpawner as createTranscriptionWorkerThreadsSpawner } from './transcription/queue/worker-threads-transport';
import { resolveWhisperCliPath } from './transcription/whisper-cli';
import {
  createTranscriptionOrchestrator,
  type TranscriptionOrchestrator,
} from './transcription/transcription-orchestrator';
import { installContentSecurityPolicy, type CspOptions } from './security/csp';
import { installNetworkGuard } from './security/network-guard';
import {
  applyNavigationHardening,
  buildSecureWebPreferences,
  type NavigationHardeningOptions,
} from './security/window-hardening';

const moduleDir = dirname(fileURLToPath(import.meta.url));

// The packaged renderer entry: the ONLY file:// document trusted as an IPC
// sender and the only legitimate in-app navigation target (ARCHITECTURE
// §2.1/§2.3), plus the file the production window loads.
const rendererEntryPath = join(moduleDir, '../renderer/index.html');
const rendererEntryUrl = pathToFileURL(rendererEntryPath).href;

// electron-vite serves the renderer over http and sets this only in `dev`.
const rendererDevUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const cspOptions: CspOptions = rendererDevUrl === undefined ? {} : { devServerUrl: rendererDevUrl };
const senderOptions: TrustedSenderOptions =
  rendererDevUrl === undefined
    ? { rendererEntryPath }
    : { rendererEntryPath, devServerUrl: rendererDevUrl };
const navigationOptions: NavigationHardeningOptions =
  rendererDevUrl === undefined
    ? { appEntryUrl: rendererEntryUrl }
    : { appEntryUrl: rendererEntryUrl, devServerUrl: rendererDevUrl };

// The current window — the target for streamed import:progress events.
let mainWindow: BrowserWindow | undefined;

// The off-thread ingestion harness (AC-9): the coordinator forks a worker_threads
// worker per import via the built worker entry, and streams progress back to the
// renderer through the validated event sender. The session is the single seam
// every catalog/library/import handler calls into.
const emitEvent = createEventSender((channel, payload) => {
  mainWindow?.webContents.send(channel, payload);
});
const ingestionCoordinator = createIngestionCoordinator({
  spawn: createWorkerThreadsSpawner({ scriptPath: join(moduleDir, 'ingestion-worker.js') }),
  emitProgress: (event) => emitEvent(IMPORT_PROGRESS, event),
});

// The opt-in transcription-model download manager (AC-17 / ADR-0027). Built in
// bootstrap() once the app is ready (it needs the guarded `session.defaultSession`
// and `userData` path), then driven by the transcription IPC handlers. It is
// NEVER auto-started — only the caller-initiated `transcription:downloadModel`
// channel begins a download (the consent UI is card #132).
let modelDownloader: ReturnType<typeof createModelDownloader> | undefined;
function requireModelController(): ReturnType<typeof createModelDownloader> {
  if (modelDownloader === undefined) {
    throw new Error('the transcription model downloader is not initialised yet');
  }
  return modelDownloader;
}

// The off-thread transcription engine (AC-18, #157). The coordinator owns the
// worker_threads lifecycle and relays each job's events onto a sink — wired here
// to the orchestrator via a forward-reference closure (the orchestrator is built
// in bootstrap(), once the model + consent stores exist). The coordinator itself
// is inert until `start()` spawns a worker, so building it at module load is safe.
const transcriptionCoordinator = createTranscriptionCoordinator({
  spawn: createTranscriptionWorkerThreadsSpawner({
    scriptPath: join(moduleDir, 'transcription-worker.js'),
  }),
  emit: (event) => transcriptionOrchestrator?.handleWorkerEvent(event),
});

// The gated transcription RUN orchestrator (#157) + the durable opt-in store it
// reads. Both are built in bootstrap() (they need the `userData` path and the
// model downloader); the run IPC handlers reach them through these requires.
let transcriptionOrchestrator: TranscriptionOrchestrator | undefined;
let transcriptionConsentStore: ConsentStore | undefined;
function requireTranscriptionController(): TranscriptionOrchestrator {
  if (transcriptionOrchestrator === undefined) {
    throw new Error('the transcription orchestrator is not initialised yet');
  }
  return transcriptionOrchestrator;
}
function requireConsentStore(): ConsentStore {
  if (transcriptionConsentStore === undefined) {
    throw new Error('the transcription consent store is not initialised yet');
  }
  return transcriptionConsentStore;
}

// The thumbnail decoders (U4), injected into the catalog session so it stays
// Electron-free and unit-testable. Photos use Electron's built-in `nativeImage`
// (NO new dependency); videos reuse the existing ffmpeg wrapper to pipe a single
// frame. Both only ever receive a path the session resolved + confined itself.
const imageThumbnailer: ImageThumbnailer = async (absPath, maxDimension) => {
  const image = nativeImage.createFromPath(absPath);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const longest = Math.max(width, height);
  // Downscale only — never upscale — bounding the LONGEST edge to maxDimension
  // while preserving aspect ratio. A JPEG keeps the data: URL small and calm.
  const bounded =
    longest > maxDimension
      ? image.resize(width >= height ? { width: maxDimension } : { height: maxDimension })
      : image;
  return { data: bounded.toJPEG(80), mimeType: 'image/jpeg' };
};

// The per-arch ffmpeg + ffprobe paths are resolved on the HOST (they need
// app/electron globals) and threaded into the off-thread workers as strings —
// exactly like the model + whisper-cli paths (#175). Resolution is LAZY: called
// when a video poster is built or an import/transcription starts, never at boot,
// so a dev/CI checkout without staged binaries only fails when the feature is
// actually used (packaged builds ship them under resourcesPath).
function resolveFfmpegBinaryPath(): string {
  return resolveFfmpegPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    projectRoot: app.getAppPath(),
  });
}

function resolveMediaBinaries(): { ffmpegPath: string; ffprobePath: string } {
  const base = {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    projectRoot: app.getAppPath(),
  };
  return {
    ffmpegPath: resolveFfmpegPath(base),
    ffprobePath: resolveFfprobePath(base),
  };
}

// The bundled ffmpeg may be absent in a dev/CI checkout (no staged binary); if
// it can't be resolved, videos simply fall back to their type icon rather than
// crashing the boot path. Resolved lazily here inside the guard.
function buildVideoThumbnailer(): VideoThumbnailer {
  try {
    const frame = createFfmpegVideoFrameThumbnailer({ ffmpegPath: resolveFfmpegBinaryPath() });
    return (absPath, maxDimension) => frame(absPath, maxDimension);
  } catch {
    return async () => null;
  }
}

const catalogSession = createCatalogSession({
  coordinator: ingestionCoordinator,
  thumbnailers: { image: imageThumbnailer, video: buildVideoThumbnailer() },
  resolveMediaBinaries,
});

// The native open-dialog capability (W2): always parented to the focused window
// (falling back to the current main window) so it appears as a sheet/modal, and
// only ever invoked with the handler's hardcoded `properties` — the renderer can
// influence nothing but a title/defaultPath.
const showOpenDialog: ShowOpenDialog = (options) => {
  const parent = BrowserWindow.getFocusedWindow() ?? mainWindow;
  return parent !== undefined
    ? dialog.showOpenDialog(parent, options)
    : dialog.showOpenDialog(options);
};

// The single source of truth for the renderer's capabilities. Each handler is a
// pure, separately-tested function; the registrar adds the sender + zod guards.
const ipcHandlers: IpcHandlerMap = {
  [APP_GET_VERSION]: () => handleGetVersion({ getVersion: () => app.getVersion() }),
  [LIBRARY_CREATE]: (request) => catalogSession.createLibrary(request),
  [LIBRARY_OPEN]: (request) => catalogSession.openLibrary(request),
  [CATALOG_TIMELINE]: (request) => catalogSession.getTimeline(request),
  [CATALOG_SEARCH]: (request) => catalogSession.search(request),
  [CATALOG_THUMBNAIL]: (request) => catalogSession.getThumbnail(request),
  [CATALOG_GET_TRANSCRIPT]: (request) => catalogSession.getTranscript(request),
  [IMPORT_START]: (request) => catalogSession.beginImport(request),
  [IMPORT_CANCEL]: (request) => catalogSession.cancelImport(request),
  [DIALOG_OPEN_DIRECTORY]: (request) => handleOpenDirectory({ showOpenDialog }, request),
  [DIALOG_OPEN_FILE]: (request) => handleOpenFile({ showOpenDialog }, request),
  [TRANSCRIPTION_DOWNLOAD_MODEL]: () => {
    // Downloading the model IS the explicit opt-in action (AC-22): record the
    // durable consent here so a later `transcription:start` is permitted. The
    // renderer reaches this only by the user choosing to enable transcription.
    requireConsentStore().setOptedIn(true);
    return handleDownloadModel({ controller: requireModelController() });
  },
  [TRANSCRIPTION_MODEL_STATUS]: () => handleModelStatus({ controller: requireModelController() }),
  [TRANSCRIPTION_START]: () =>
    handleStartTranscription({ controller: requireTranscriptionController() }),
  [TRANSCRIPTION_STATUS]: () =>
    handleTranscriptionStatus({ controller: requireTranscriptionController() }),
  [TRANSCRIPTION_CANCEL]: () =>
    handleCancelTranscription({ controller: requireTranscriptionController() }),
};

function createMainWindow(): void {
  const preloadPath = join(moduleDir, '../preload/index.cjs');
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 880,
    minHeight: 640,
    show: false,
    backgroundColor: '#f6f2ee',
    webPreferences: buildSecureWebPreferences(preloadPath, { devTools: !app.isPackaged }),
  });

  applyNavigationHardening(window.webContents, navigationOptions);
  window.once('ready-to-show', () => {
    window.show();
  });
  mainWindow = window;
  window.on('closed', () => {
    // Terminate any in-flight worker so none is orphaned (AC-9 / AC-18 teardown).
    ingestionCoordinator.disposeAll();
    transcriptionCoordinator.disposeAll();
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });

  if (rendererDevUrl === undefined) {
    void window.loadFile(rendererEntryPath);
  } else {
    void window.loadURL(rendererDevUrl);
  }
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // Security guards are installed BEFORE any window loads content (ARCHITECTURE §10).
  installContentSecurityPolicy(session.defaultSession, cspOptions);
  // The runtime zero-egress kill-switch (AC-4): cancel every non-local request.
  installNetworkGuard(session.defaultSession, { isPackaged: app.isPackaged });

  // The model download flows through Electron `net` on the GUARDED session, so it
  // passes through the webRequest allowlist above — not Node http/https, which
  // would bypass the guard. The verified model lands under userData/models.
  modelDownloader = createModelDownloader({
    fetcher: createElectronModelFetcher(net, session.defaultSession),
    modelPath: join(app.getPath('userData'), 'models', MODEL_FILE_NAME),
    onProgress: (progress) => emitEvent(TRANSCRIPTION_MODEL_DOWNLOAD_PROGRESS, progress),
  });

  // The durable opt-in record (AC-22) and the gated run orchestrator (#157). The
  // orchestrator NEVER auto-starts — it runs only when `transcription:start` is
  // invoked AND both gates pass (opted in + model present-and-verified). It drives
  // the off-thread coordinator over the open library's audio/video, persists each
  // outcome host-side (#135), and streams a calm progress snapshot to the renderer.
  transcriptionConsentStore = createConsentStore({
    filePath: join(app.getPath('userData'), 'transcription-consent.json'),
  });
  transcriptionOrchestrator = createTranscriptionOrchestrator({
    gate: {
      isOptedIn: () => requireConsentStore().isOptedIn(),
      isModelReady: () => requireModelController().isModelReady(),
    },
    getLibrary: () => catalogSession.transcription(),
    worker: {
      start: (job) => transcriptionCoordinator.start(job),
      cancel: (jobId) => transcriptionCoordinator.cancel(jobId),
    },
    resolveJobConfig: () => ({
      modelPath: join(app.getPath('userData'), 'models', MODEL_FILE_NAME),
      // Resolved per-run: throws only in a dev/CI checkout without the built
      // binary (packaged builds ship it under resourcesPath).
      whisperCliPath: resolveWhisperCliPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        projectRoot: app.getAppPath(),
      }),
      // The per-arch ffmpeg for audio extraction, resolved per-run like the
      // whisper-cli binary above (#175).
      ffmpegPath: resolveFfmpegBinaryPath(),
      // App-local, confined scratch for extracted WAVs — the user's originals are
      // never written to (AC-14); the worker confines extraction under here.
      scratchDir: join(app.getPath('userData'), 'transcription-scratch'),
    }),
    emitProgress: (snapshot) => emitEvent(TRANSCRIPTION_PROGRESS, snapshot),
  });

  registerIpcHandlers(ipcMain, ipcHandlers, senderOptions);

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

app.on('window-all-closed', () => {
  // Standard macOS behaviour: stay resident until the user explicitly quits.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Full teardown on quit: close the open library and terminate every worker.
  catalogSession.dispose();
});

void bootstrap();
