import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, session } from 'electron';
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
import { handleGetVersion } from './ipc/handlers/app';
import { registerIpcHandlers, type IpcHandlerMap } from './ipc/register';
import { createEventSender } from './ipc/event-sender';
import type { TrustedSenderOptions } from './ipc/sender';
import { createCatalogSession } from './app/catalog-session';
import { createIngestionCoordinator } from './importers/ingestion/coordinator';
import { createWorkerThreadsSpawner } from './importers/ingestion/worker-threads-transport';
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
const catalogSession = createCatalogSession({ coordinator: ingestionCoordinator });

// The single source of truth for the renderer's capabilities. Each handler is a
// pure, separately-tested function; the registrar adds the sender + zod guards.
const ipcHandlers: IpcHandlerMap = {
  [APP_GET_VERSION]: () => handleGetVersion({ getVersion: () => app.getVersion() }),
  [LIBRARY_CREATE]: (request) => catalogSession.createLibrary(request),
  [LIBRARY_OPEN]: (request) => catalogSession.openLibrary(request),
  [CATALOG_TIMELINE]: (request) => catalogSession.getTimeline(request),
  [CATALOG_SEARCH]: (request) => catalogSession.search(request),
  [IMPORT_START]: (request) => catalogSession.beginImport(request),
  [IMPORT_CANCEL]: (request) => catalogSession.cancelImport(request),
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
    // Terminate any in-flight import worker so none is orphaned (AC-9 teardown).
    ingestionCoordinator.disposeAll();
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
