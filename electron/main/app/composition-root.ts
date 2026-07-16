// The composition root (ARCHITECTURE §2.3): the single place the whole main-process
// dependency graph is built and wired. It exists so `electron/main/index.ts` can be a
// thin entrypoint — register the privileged media scheme at module load, build the
// Electron {@link MainRuntime} seam, and hand off to {@link createCompositionRoot}.
//
// Every Electron RUNTIME touchpoint (app/session/net/ipcMain/BrowserWindow/dialog/
// nativeImage/protocol) is injected through {@link MainRuntime}, so this module never
// imports the Electron runtime and the whole wiring — crucially the load-bearing
// security-install ORDER inside {@link bootstrap} — is unit-testable under Vitest with
// a fake runtime. The pure collaborators it composes (security guards, the catalog
// session, the model/consent/settings stores, the orchestrators) are each unit-tested
// in isolation; this root only assembles them.
//
// The two-phase lifetime is preserved verbatim:
//   • Phase 1 (construction) — the module-load-safe singletons that are inert until
//     used: the event sender, the ingestion + transcription coordinators, and the
//     catalog session. They may be built before `app.whenReady()`.
//   • Phase 2 (bootstrap, post-`whenReady`) — everything that needs the guarded
//     `session.defaultSession` or the `userData` path: the model downloader, the
//     transcription orchestrator + consent, smart search, categorization consent, and
//     the settings store. Held in typed {@link LazyValue} cells whose `demand()`
//     throws until bootstrap has set them (mirroring the former `require*()` guards).

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  NativeImage,
  Net,
  OpenDialogOptions,
  OpenDialogReturnValue,
  Session,
} from 'electron';
import {
  APP_GET_VERSION,
  CATALOG_GET_COLLECTION,
  CATALOG_GET_TRANSCRIPT,
  CATALOG_LIST_COLLECTIONS,
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
} from '@shared/ipc/contract';
import {
  CATEGORIZE_PROGRESS,
  IMPORT_PROGRESS,
  SMART_SEARCH_MODEL_DOWNLOAD_PROGRESS,
  TRANSCRIPTION_MODEL_DOWNLOAD_PROGRESS,
  TRANSCRIPTION_PROGRESS,
} from '@shared/ipc/events';
import { handleGetVersion } from '../ipc/handlers/app';
import { handleOpenDirectory, handleOpenFile, type ShowOpenDialog } from '../ipc/handlers/dialog';
import { handleDownloadModel, handleModelStatus } from '../ipc/handlers/transcription';
import {
  handleCancelTranscription,
  handleStartTranscription,
  handleTranscriptionStatus,
} from '../ipc/handlers/transcription-run';
import { handleSmartSearchEnable, handleSmartSearchStatus } from '../ipc/handlers/smart-search';
import {
  handleCategorizationApplyCorrection,
  handleCategorizationCancel,
  handleCategorizationListForItem,
  handleCategorizationSetConsent,
  handleCategorizationStart,
  handleCategorizationStatus,
} from '../ipc/handlers/categorize';
import {
  handleSuggestionsAccept,
  handleSuggestionsDismiss,
  handleSuggestionsList,
  handleSuggestionsMerge,
} from '../ipc/handlers/suggestions';
import { handleSettingsGet, handleSettingsSet } from '../ipc/handlers/settings';
import { registerIpcHandlers, type IpcHandlerMap, type IpcMainLike } from '../ipc/register';
import { createEventSender } from '../ipc/event-sender';
import type { TrustedSenderOptions } from '../ipc/sender';
import { createCatalogSession, type CatalogSession } from './catalog-session';
import { log } from '../log';
import { loadRenderer } from './load-renderer';
import { createIngestionCoordinator } from '../importers/ingestion/coordinator';
import { createWorkerThreadsSpawner } from '../importers/ingestion/worker-threads-transport';
import { createFfmpegVideoFrameThumbnailer } from '../importers/deps/thumbnail';
import { resolveFfmpegPath, resolveFfprobePath } from '../importers/deps/media-binaries';
import { createEmbedder } from '../search/embed-cli';
import {
  createEmbedModelDownloader,
  createSmartSearchConsentStore,
  createSmartSearchController,
  type SmartSearchController,
} from '../search/smart-search-model';
import { isEmbedModelPublished } from '../search/embed-model-source';
import { createCategorizationConsentStore } from '../categorize/categorization-consent';
import { createCategorizationLibraryPort } from '../categorize/categorization-library';
import { createCancelFlaggedCategorizationPort } from '../categorize/categorization-cancel-flag';
import { createSuggestionsLibraryPort } from '../categorize/suggestions-library';
import { isGazetteerBundled, loadGazetteer } from '../categorize/gazetteer';
import { createProductionClusterTransport } from '../categorize/categorization-worker';
import { resolveCategorizationStatus } from '../categorize/categorization-orchestrator';
import type { ImageThumbnailer, VideoThumbnailer } from '../library/thumbnail-service';
import { createModelDownloader } from '../transcription/model-download';
import { createElectronModelFetcher } from '../transcription/electron-net-fetcher';
import { MODEL_FILE_NAME } from '../transcription/model-source';
import { createConsentStore, type ConsentStore } from '../transcription/consent-store';
import { createSettingsStore, type SettingsStore } from '../settings/settings-store';
import { createTranscriptionCoordinator } from '../transcription/queue/coordinator';
import { createWorkerThreadsSpawner as createTranscriptionWorkerThreadsSpawner } from '../transcription/queue/worker-threads-transport';
import { resolveWhisperCliPath } from '../transcription/whisper-cli';
import {
  createTranscriptionOrchestrator,
  type TranscriptionOrchestrator,
} from '../transcription/transcription-orchestrator';
import { installContentSecurityPolicy, type CspOptions } from '../security/csp';
import { installNetworkGuard } from '../security/network-guard';
import { createMediaProtocolHandler } from '../security/media-protocol';
import { MEDIA_PROTOCOL_SCHEME } from '@shared/media';
import {
  applyNavigationHardening,
  buildSecureWebPreferences,
  type NavigationHardeningOptions,
} from '../security/window-hardening';

/**
 * The Electron RUNTIME seam. Every Electron global the main process touches is
 * reached through this interface so the composition root imports no Electron
 * runtime and the wiring is testable with a fake. The real implementation is built
 * in `electron/main/index.ts`, the ONLY module that imports the Electron runtime.
 */
export interface MainRuntime {
  /** The directory of the built main entry (`out/main`) — the anchor for the
   *  preload/renderer/worker paths. Passed in (not derived from `import.meta.url`)
   *  because this module is bundled INTO the entry, so only the entry knows it. */
  readonly moduleDir: string;
  /** `app.isPackaged` — a constant for the process lifetime. */
  readonly isPackaged: boolean;
  /** The Vite dev-server URL in development, else undefined (production). */
  readonly rendererDevUrl: string | undefined;
  /** `process.resourcesPath` — the packaged resources root. */
  readonly resourcesPath: string;
  /** `app.getVersion()`. */
  getVersion(): string;
  /** `app.getPath('userData')` — the per-user writable app directory. */
  getUserDataPath(): string;
  /** `app.getAppPath()` — the app root (a dev/test checkout in unpackaged runs). */
  getAppPath(): string;
  /** `app.whenReady()`. */
  whenReady(): Promise<void>;
  /**
   * The guarded default session (`session.defaultSession`). A DEFERRED thunk, not
   * an eager value: Electron throws "Session can only be received when app is
   * ready" if `session.defaultSession` is read before `app.whenReady()`, so this is
   * only ever called from inside {@link CompositionRoot.bootstrap}, AFTER whenReady.
   */
  getSession(): Session;
  /** Electron's `net` — issues the model download through the guarded session. */
  readonly net: Net;
  /** `ipcMain` — the invoke registrar. */
  readonly ipcMain: IpcMainLike;
  /** `nativeImage.createFromPath` — the photo thumbnail decoder. */
  createImageFromPath(path: string): NativeImage;
  /** `new BrowserWindow(options)`. */
  createBrowserWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  /** `BrowserWindow.getFocusedWindow()` — the dialog parent, or null. */
  getFocusedWindow(): BrowserWindow | null;
  /** `dialog.showOpenDialog`, parented to the given window when present. */
  showOpenDialog(
    parent: BrowserWindow | undefined,
    options: OpenDialogOptions,
  ): Promise<OpenDialogReturnValue>;
  /** `BrowserWindow.getAllWindows().length` — the macOS re-activate guard. */
  getAllWindowsCount(): number;
  /** `app.on('activate', listener)`. */
  onActivate(listener: () => void): void;
}

/** The composition root's public surface: kick off the app, and tear it down. */
export interface CompositionRoot {
  /** Post-`whenReady` wiring: install the security guards + media protocol on the
   *  guarded session, build the phase-2 services, register the IPC handlers, and
   *  open the main window — in exactly that order (ARCHITECTURE §2.2/§6.1). */
  bootstrap(): Promise<void>;
  /** Full teardown on quit: close the open library + terminate every worker. */
  dispose(): void;
}

/**
 * A typed lazy cell for a phase-2 singleton. `demand()` throws the SAME
 * "not initialised yet" diagnostic the former `require*()` guards did, until
 * `set()` supplies the value inside {@link CompositionRoot.bootstrap}; `peek()` is
 * the non-throwing read used by the coordinator's forward-reference sink.
 *
 * (The throwing accessor is deliberately NOT named `require` — that bare token
 * would make electron-vite's CJS-interop plugin treat the ESM main bundle as
 * CommonJS and inject a `__dirname`/`require` shim, corrupting the output.)
 */
interface LazyValue<T> {
  set(value: T): void;
  demand(): T;
  peek(): T | undefined;
}

function createLazyValue<T>(notReadyMessage: string): LazyValue<T> {
  let value: T | undefined;
  return {
    set(next) {
      value = next;
    },
    demand() {
      if (value === undefined) {
        throw new Error(notReadyMessage);
      }
      return value;
    },
    peek() {
      return value;
    },
  };
}

/**
 * The dependencies the IPC handler map closes over. Made explicit (was a set of
 * ambient closures over module-level singletons) so {@link buildIpcHandlers} is a
 * pure, separately-testable factory. The `require*` accessors reach the phase-2
 * singletons (throwing before bootstrap); the `isOffered` predicates read the
 * post-bootstrap capability latches at invoke time.
 */
export interface IpcHandlerDeps {
  readonly catalogSession: CatalogSession;
  getVersion(): string;
  readonly showOpenDialog: ShowOpenDialog;
  requireModelController(): ReturnType<typeof createModelDownloader>;
  requireConsentStore(): ConsentStore;
  requireTranscriptionController(): TranscriptionOrchestrator;
  requireSmartSearchController(): SmartSearchController;
  requireCategorizationConsentStore(): ConsentStore;
  requireSettingsStore(): SettingsStore;
  /** `smartSearch:modelStatus`'s `offered`: a real model is published AND this
   *  platform can install the embedder (the post-bootstrap downloader result). */
  isSmartSearchOffered(): boolean;
  /** `categorize:status`'s `offered`: the gazetteer asset is bundled. */
  isCategorizationOffered(): boolean;
}

/**
 * The single source of truth for the renderer's capabilities: exactly one handler
 * per contract channel. Each business handler is a pure, separately-tested function;
 * the registrar adds the trusted-sender + zod guards around them.
 */
export function buildIpcHandlers(deps: IpcHandlerDeps): IpcHandlerMap {
  const { catalogSession } = deps;
  return {
    [APP_GET_VERSION]: () => handleGetVersion({ getVersion: () => deps.getVersion() }),
    [LIBRARY_CREATE]: (request) => catalogSession.createLibrary(request),
    [LIBRARY_OPEN]: (request) => catalogSession.openLibrary(request),
    [CATALOG_TIMELINE]: (request) => catalogSession.getTimeline(request),
    [CATALOG_SEARCH]: (request) => catalogSession.search(request),
    [CATALOG_THUMBNAIL]: (request) => catalogSession.getThumbnail(request),
    [CATALOG_GET_TRANSCRIPT]: (request) => catalogSession.getTranscript(request),
    [CATALOG_SET_FAVOURITE]: (request) => catalogSession.setFavourite(request),
    [CATALOG_LIST_COLLECTIONS]: () => catalogSession.listCollections(),
    [CATALOG_GET_COLLECTION]: (request) => catalogSession.getCollection(request),
    [IMPORT_START]: (request) => catalogSession.beginImport(request),
    [IMPORT_CANCEL]: (request) => catalogSession.cancelImport(request),
    [CATALOG_UNDO_IMPORT]: (request) => catalogSession.undoImport(request),
    [DIALOG_OPEN_DIRECTORY]: (request) =>
      handleOpenDirectory({ showOpenDialog: deps.showOpenDialog }, request),
    [DIALOG_OPEN_FILE]: (request) => handleOpenFile({ showOpenDialog: deps.showOpenDialog }, request),
    [TRANSCRIPTION_DOWNLOAD_MODEL]: () => {
      // Downloading the model IS the explicit opt-in action (AC-22): record the
      // durable consent here so a later `transcription:start` is permitted. The
      // renderer reaches this only by the user choosing to enable transcription.
      deps.requireConsentStore().setOptedIn(true);
      return handleDownloadModel({ controller: deps.requireModelController() });
    },
    [TRANSCRIPTION_MODEL_STATUS]: () =>
      handleModelStatus({ controller: deps.requireModelController() }),
    [TRANSCRIPTION_START]: () =>
      handleStartTranscription({ controller: deps.requireTranscriptionController() }),
    [TRANSCRIPTION_STATUS]: () =>
      handleTranscriptionStatus({ controller: deps.requireTranscriptionController() }),
    [TRANSCRIPTION_CANCEL]: () =>
      handleCancelTranscription({ controller: deps.requireTranscriptionController() }),
    [SMART_SEARCH_DOWNLOAD_MODEL]: () =>
      handleSmartSearchEnable({ controller: deps.requireSmartSearchController() }),
    [SMART_SEARCH_MODEL_STATUS]: () =>
      handleSmartSearchStatus({
        controller: deps.requireSmartSearchController(),
        // `offered` is true ONLY when a real model is published AND this platform can
        // install it — read lazily so it reflects bootstrap()'s downloader result.
        isOffered: () => deps.isSmartSearchOffered(),
      }),
    [CATEGORIZE_STATUS]: () =>
      handleCategorizationStatus({
        consent: deps.requireCategorizationConsentStore(),
        // `offered` reveals the opt-in UI ONLY once the gazetteer asset is bundled.
        isOffered: () => deps.isCategorizationOffered(),
      }),
    [CATEGORIZE_SET_CONSENT]: (request) =>
      handleCategorizationSetConsent({ consent: deps.requireCategorizationConsentStore() }, request),
    [CATEGORIZE_LIST_FOR_ITEM]: (request) =>
      handleCategorizationListForItem(
        { getLibrary: () => catalogSession.categorization() },
        request,
      ),
    [CATEGORIZE_APPLY_CORRECTION]: (request) =>
      handleCategorizationApplyCorrection(
        { getLibrary: () => catalogSession.categorization() },
        request,
      ),
    [CATEGORIZE_START]: () =>
      handleCategorizationStart({ getLibrary: () => catalogSession.categorization() }),
    [CATEGORIZE_CANCEL]: () =>
      handleCategorizationCancel({ getLibrary: () => catalogSession.categorization() }),
    [SUGGESTIONS_LIST]: () =>
      handleSuggestionsList({ getLibrary: () => catalogSession.suggestions() }),
    [SUGGESTIONS_ACCEPT]: (request) =>
      handleSuggestionsAccept({ getLibrary: () => catalogSession.suggestions() }, request),
    [SUGGESTIONS_MERGE]: (request) =>
      handleSuggestionsMerge({ getLibrary: () => catalogSession.suggestions() }, request),
    [SUGGESTIONS_DISMISS]: (request) =>
      handleSuggestionsDismiss({ getLibrary: () => catalogSession.suggestions() }, request),
    [SETTINGS_GET]: () => handleSettingsGet({ settings: deps.requireSettingsStore() }),
    [SETTINGS_SET]: (request) =>
      handleSettingsSet({ settings: deps.requireSettingsStore() }, request),
  };
}

/**
 * Build and wire the entire main-process dependency graph against the injected
 * {@link MainRuntime}. Constructs the phase-1 singletons immediately and returns a
 * {@link CompositionRoot} whose {@link CompositionRoot.bootstrap} performs the
 * phase-2, post-`whenReady` wiring in the security-critical order.
 */
export function createCompositionRoot(runtime: MainRuntime): CompositionRoot {
  const { moduleDir } = runtime;

  // The packaged renderer entry: the ONLY file:// document trusted as an IPC sender
  // and the only legitimate in-app navigation target (ARCHITECTURE §2.1/§2.3), plus
  // the file the production window loads.
  const rendererEntryPath = join(moduleDir, '../renderer/index.html');
  const rendererEntryUrl = pathToFileURL(rendererEntryPath).href;
  const { rendererDevUrl } = runtime;
  const cspOptions: CspOptions = rendererDevUrl === undefined ? {} : { devServerUrl: rendererDevUrl };
  const senderOptions: TrustedSenderOptions =
    rendererDevUrl === undefined
      ? { rendererEntryPath }
      : { rendererEntryPath, devServerUrl: rendererDevUrl };
  const navigationOptions: NavigationHardeningOptions =
    rendererDevUrl === undefined
      ? { appEntryUrl: rendererEntryUrl }
      : { appEntryUrl: rendererEntryUrl, devServerUrl: rendererDevUrl };

  // The bundled-asset resolution inputs shared by every host-side path resolver + the
  // `offered` gates. Read app/electron globals via the runtime, so it is called at
  // invoke/library-open time (post-`whenReady`), never at construction.
  const resolveInputs = (): {
    isPackaged: boolean;
    resourcesPath: string;
    projectRoot: string;
  } => ({
    isPackaged: runtime.isPackaged,
    resourcesPath: runtime.resourcesPath,
    projectRoot: runtime.getAppPath(),
  });

  // The current window — the target for the streamed progress events.
  let mainWindow: BrowserWindow | undefined;

  // ── Phase 1: module-load-safe singletons (inert until used) ──────────────────

  // The validated event sender: the last guard before a payload crosses into the
  // renderer, wired to the current window's webContents.
  const emitEvent = createEventSender((channel, payload) => {
    mainWindow?.webContents.send(channel, payload);
  });

  // The off-thread ingestion harness (AC-9): forks a worker_threads worker per
  // import and streams progress back through the validated event sender.
  const ingestionCoordinator = createIngestionCoordinator({
    spawn: createWorkerThreadsSpawner({ scriptPath: join(moduleDir, 'ingestion-worker.js') }),
    emitProgress: (event) => emitEvent(IMPORT_PROGRESS, event),
    // Route worker faults through the REDACTING logger (#440; closes #480 item 2):
    // pass the Error as a separate arg so `projectError` reduces it to {name, code} —
    // never the raw stack/message the coordinator's bare-console default would print.
    logWorkerFault: (error) => log.error('[kawsay] ingestion worker fault', error),
  });

  // ── Phase 2 cells: set in bootstrap(), post-`whenReady` ──────────────────────
  const modelDownloader = createLazyValue<ReturnType<typeof createModelDownloader>>(
    'the transcription model downloader is not initialised yet',
  );
  const transcriptionConsentStore = createLazyValue<ConsentStore>(
    'the transcription consent store is not initialised yet',
  );
  const transcriptionOrchestrator = createLazyValue<TranscriptionOrchestrator>(
    'the transcription orchestrator is not initialised yet',
  );
  const smartSearchController = createLazyValue<SmartSearchController>(
    'the smart-search controller is not initialised yet',
  );
  const categorizationConsentStore = createLazyValue<ConsentStore>(
    'the categorization consent store is not initialised yet',
  );
  const settingsStore = createLazyValue<SettingsStore>(
    'the settings store is not initialised yet',
  );
  // Whether THIS platform can install the embedder (the downloader is null otherwise);
  // read lazily by the smart-search status handler after bootstrap sets it.
  let smartSearchDownloaderSupported = false;

  // The off-thread transcription engine (AC-18, #157). The coordinator relays each
  // job's events to the orchestrator via a forward-reference peek (the orchestrator
  // is built in bootstrap()); it is inert until `start()` spawns a worker.
  const transcriptionCoordinator = createTranscriptionCoordinator({
    spawn: createTranscriptionWorkerThreadsSpawner({
      scriptPath: join(moduleDir, 'transcription-worker.js'),
    }),
    emit: (event) => transcriptionOrchestrator.peek()?.handleWorkerEvent(event),
  });

  // The photo thumbnail decoder (U4): Electron's built-in `nativeImage` (NO new
  // dependency), downscaling to a bounded JPEG. It only ever receives a path the
  // catalog session resolved + confined itself.
  const imageThumbnailer: ImageThumbnailer = async (absPath, maxDimension) => {
    const image = runtime.createImageFromPath(absPath);
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

  // The per-arch ffmpeg path, resolved on the HOST and threaded into the off-thread
  // workers as a string. Resolution is LAZY: called when a poster is built or an
  // import/transcription starts, never at boot, so a dev/CI checkout without staged
  // binaries only fails when the feature is actually used.
  const resolveFfmpegBinaryPath = (): string => resolveFfmpegPath(resolveInputs());

  const resolveMediaBinaries = (): { ffmpegPath: string; ffprobePath: string } => {
    const base = resolveInputs();
    // E2E-ONLY escape hatch (#445): the packaged app ships ffmpeg/ffprobe only for
    // macOS + Windows, and resolution HARD-throws on an unshipped platform (Linux CI)
    // or an unstaged dev checkout — which would abort even a media-free import at
    // `beginImport`. When — and ONLY when — the harness sets `KAWSAY_E2E`, degrade a
    // failed resolution to an empty path (mirroring the video-thumbnailer's existing
    // try/catch degrade) so the user-journey e2e suite can drive a real, offline
    // import end-to-end. Production never sets this env var, so its behaviour is
    // byte-identical (the throw is preserved); a media file under the flag simply
    // skips its probe.
    const e2e = process.env['KAWSAY_E2E'] === '1';
    const resolveOrDegrade = (resolve: (opts: typeof base) => string): string => {
      try {
        return resolve(base);
      } catch (error) {
        if (e2e) return '';
        throw error;
      }
    };
    return {
      ffmpegPath: resolveOrDegrade(resolveFfmpegPath),
      ffprobePath: resolveOrDegrade(resolveFfprobePath),
    };
  };

  // The bundled ffmpeg may be absent in a dev/CI checkout (no staged binary); if it
  // can't be resolved, videos simply fall back to their type icon rather than
  // crashing the boot path. Resolved lazily here inside the guard.
  const buildVideoThumbnailer = (): VideoThumbnailer => {
    try {
      const frame = createFfmpegVideoFrameThumbnailer({ ffmpegPath: resolveFfmpegBinaryPath() });
      return (absPath, maxDimension) => frame(absPath, maxDimension);
    } catch {
      return async () => null;
    }
  };

  // The catalog application service — the single seam every catalog/library/import
  // handler calls into (ARCHITECTURE §2.3). Injected its Electron-free collaborators
  // (thumbnailers, lazy binary/embedder/categorization/suggestions factories) so it
  // stays fully unit-testable.
  const catalogSession = createCatalogSession({
    coordinator: ingestionCoordinator,
    thumbnailers: { image: imageThumbnailer, video: buildVideoThumbnailer() },
    resolveMediaBinaries,
    // The on-device text embedder for M4 smart search (ADR-0029). Resolved lazily
    // (like the media binaries) and non-throwing: until the packaging slice bundles
    // the binary + model it degrades to UNAVAILABLE, so search stays exact FTS.
    resolveEmbedder: () => createEmbedder(resolveInputs()),
    // The per-library categorization port (M4-2h / #270), built once per open library.
    // Places need only the bundled gazetteer; themes additionally need the opted-in
    // embedder, so the gate degrades to places-only when the embedder is unavailable.
    // The cluster passes run OFF the main thread through the real worker_thread
    // transport (#344): each run spawns a fresh worker (out/main/categorization-cluster-
    // worker.js) and terminates it afterward, so IPC/window responsiveness — crucially
    // `categorize:cancel` — never stalls while clustering runs. Resolution is LAZY and
    // NON-throwing (mirroring the ffmpeg/embedder degrade): a dev/CI checkout without a
    // built worker falls back to the in-process inline transport. The per-library cancel
    // flag the wrapped `start`/`cancel` toggle is threaded into the inline fallback; the
    // worker path doesn't need it because the orchestrator's post-transport
    // `isCancelled()` check discards any writes when a cancel lands mid-run.
    categorization: ({ db, embedderAvailable }) =>
      createCancelFlaggedCategorizationPort((isCancelled) =>
        createCategorizationLibraryPort({
          db,
          gazetteer: loadGazetteer(resolveInputs()),
          transport: createProductionClusterTransport({
            scriptPath: join(moduleDir, 'categorization-cluster-worker.js'),
            isCancelled,
          }),
          getStatus: () =>
            resolveCategorizationStatus({
              optedIn: categorizationConsentStore.demand().isOptedIn(),
              placesAvailable: isGazetteerBundled(resolveInputs()),
              themesAvailable: embedderAvailable(),
            }),
          onProgress: (snapshot) => emitEvent(CATEGORIZE_PROGRESS, snapshot),
        }),
      ),
    // The per-library SUGGESTED-COLLECTIONS tray port (M4-3c / #273), built once per
    // open library. A read-then-curate surface over the derivation (#271) + curation
    // repo (#272); it needs only the live DB (no embedder/gazetteer gate — the tray's
    // reveal is gated in the renderer by the categorization opt-in, like the chips).
    suggestions: ({ db }) => createSuggestionsLibraryPort({ db }),
  });

  // The native open-dialog capability (W2): always parented to the focused window
  // (falling back to the current main window) so it appears as a sheet/modal, and
  // only ever invoked with the handler's hardcoded `properties`.
  const showOpenDialog: ShowOpenDialog = (options) => {
    const parent = runtime.getFocusedWindow() ?? mainWindow;
    return runtime.showOpenDialog(parent, options);
  };

  const ipcHandlers = buildIpcHandlers({
    catalogSession,
    getVersion: () => runtime.getVersion(),
    showOpenDialog,
    requireModelController: () => modelDownloader.demand(),
    requireConsentStore: () => transcriptionConsentStore.demand(),
    requireTranscriptionController: () => transcriptionOrchestrator.demand(),
    requireSmartSearchController: () => smartSearchController.demand(),
    requireCategorizationConsentStore: () => categorizationConsentStore.demand(),
    requireSettingsStore: () => settingsStore.demand(),
    isSmartSearchOffered: () => isEmbedModelPublished() && smartSearchDownloaderSupported,
    isCategorizationOffered: () => isGazetteerBundled(resolveInputs()),
  });

  function createMainWindow(): void {
    const preloadPath = join(moduleDir, '../preload/index.cjs');
    const window = runtime.createBrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 880,
      minHeight: 640,
      show: false,
      backgroundColor: '#f6f2ee',
      webPreferences: buildSecureWebPreferences(preloadPath, { devTools: !runtime.isPackaged }),
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

    void loadRenderer(window, {
      rendererEntryPath,
      rendererDevUrl,
      onLoadFailure: (error) => {
        log.error('[kawsay] renderer failed to load', error);
      },
    });
  }

  async function bootstrap(): Promise<void> {
    await runtime.whenReady();
    // Read the guarded session ONLY now — post-whenReady — because
    // `session.defaultSession` throws if accessed before the app is ready.
    const guardedSession = runtime.getSession();

    // Security guards are installed BEFORE any window loads content (ARCHITECTURE §2.2/§6.1).
    installContentSecurityPolicy(guardedSession, cspOptions);
    // The runtime zero-egress kill-switch (AC-4): cancel every non-local request.
    installNetworkGuard(guardedSession, { isPackaged: runtime.isPackaged });

    // The hardened `kawsay-media:` handler (#428), registered on the guarded session
    // BEFORE any window loads — consistent with the security-install ordering above.
    // It serves media bytes by OPAQUE ID ONLY: the id is validated (`z.uuid()`) and
    // resolved server-side to a CONFINED originals-store file (an escaping content-
    // address is refused before any read); the renderer never supplies a path. The
    // whole path streams a local file with range support and opens no socket (AC-4).
    guardedSession.protocol.handle(
      MEDIA_PROTOCOL_SCHEME,
      createMediaProtocolHandler({
        resolve: (id) => catalogSession.resolveMedia(id),
        // A rejected serve (confinement escape / mid-stream read failure) is logged with
        // a privacy-preserving diagnostic ONLY — never a filesystem path (AC-4 posture).
        onRejected: (info) => {
          log.warn('[kawsay] media serve rejected', info);
        },
      }),
    );

    // The model download flows through Electron `net` on the GUARDED session, so it
    // passes through the webRequest allowlist above — not Node http/https, which
    // would bypass the guard. The verified model lands under userData/models.
    modelDownloader.set(
      createModelDownloader({
        fetcher: createElectronModelFetcher(runtime.net, guardedSession),
        modelPath: join(runtime.getUserDataPath(), 'models', MODEL_FILE_NAME),
        onProgress: (progress) => emitEvent(TRANSCRIPTION_MODEL_DOWNLOAD_PROGRESS, progress),
      }),
    );

    // The durable opt-in record (AC-22) and the gated run orchestrator (#157). The
    // orchestrator NEVER auto-starts — it runs only when `transcription:start` is
    // invoked AND both gates pass (opted in + model present-and-verified). It drives
    // the off-thread coordinator over the open library's audio/video, persists each
    // outcome host-side (#135), and streams a calm progress snapshot to the renderer.
    transcriptionConsentStore.set(
      createConsentStore({
        filePath: join(runtime.getUserDataPath(), 'transcription-consent.json'),
      }),
    );
    transcriptionOrchestrator.set(
      createTranscriptionOrchestrator({
        gate: {
          isOptedIn: () => transcriptionConsentStore.demand().isOptedIn(),
          isModelReady: () => modelDownloader.demand().isModelReady(),
        },
        getLibrary: () => catalogSession.transcription(),
        worker: {
          start: (job) => transcriptionCoordinator.start(job),
          cancel: (jobId) => transcriptionCoordinator.cancel(jobId),
        },
        resolveJobConfig: () => ({
          modelPath: join(runtime.getUserDataPath(), 'models', MODEL_FILE_NAME),
          // Resolved per-run: throws only in a dev/CI checkout without the built
          // binary (packaged builds ship it under resourcesPath).
          whisperCliPath: resolveWhisperCliPath(resolveInputs()),
          // The per-arch ffmpeg for audio extraction, resolved per-run like the
          // whisper-cli binary above (#175).
          ffmpegPath: resolveFfmpegBinaryPath(),
          // App-local, confined scratch for extracted WAVs — the user's originals are
          // never written to (AC-14); the worker confines extraction under here.
          scratchDir: join(runtime.getUserDataPath(), 'transcription-scratch'),
        }),
        emitProgress: (snapshot) => emitEvent(TRANSCRIPTION_PROGRESS, snapshot),
      }),
    );

    // The opt-in smart-search embedder download (M4-1b), built alongside — but fully
    // INDEPENDENT of — transcription: its OWN consent file and OWN progress event, so
    // enabling one never implies the other. It flows through the SAME guarded `net`
    // fetcher (zero-egress allowlisted) and is null on an unshipped platform (nowhere to
    // install → smart search stays exact FTS). NEVER auto-started here — only the
    // caller-initiated `smartSearch:downloadModel` channel begins a download.
    const smartSearchConsentStore = createSmartSearchConsentStore({
      filePath: join(runtime.getUserDataPath(), 'smart-search-consent.json'),
    });
    const smartSearchDownloader = createEmbedModelDownloader({
      fetcher: createElectronModelFetcher(runtime.net, guardedSession),
      resolve: resolveInputs(),
      onProgress: (progress) => emitEvent(SMART_SEARCH_MODEL_DOWNLOAD_PROGRESS, progress),
    });
    smartSearchDownloaderSupported = smartSearchDownloader !== null;
    smartSearchController.set(
      createSmartSearchController({
        consent: smartSearchConsentStore,
        downloader: smartSearchDownloader,
      }),
    );

    // The durable categorization opt-in (M4-2h / #270): its OWN consent file + key, so
    // opting in never implies transcription or smart search. The default is OPTED-OUT,
    // so no place/theme clustering runs until an explicit, well-formed opt-in.
    categorizationConsentStore.set(
      createCategorizationConsentStore({
        filePath: join(runtime.getUserDataPath(), 'categorization-consent.json'),
      }),
    );

    // The app-wide UX settings (AC-13 / Journey G, #433): its own small JSON file,
    // no bearing on any consent gate above.
    settingsStore.set(
      createSettingsStore({
        filePath: join(runtime.getUserDataPath(), 'settings.json'),
      }),
    );

    registerIpcHandlers(runtime.ipcMain, ipcHandlers, senderOptions);

    createMainWindow();

    runtime.onActivate(() => {
      if (runtime.getAllWindowsCount() === 0) {
        createMainWindow();
      }
    });
  }

  return {
    bootstrap,
    dispose() {
      // Full teardown on quit: close the open library and terminate every worker.
      catalogSession.dispose();
    },
  };
}
