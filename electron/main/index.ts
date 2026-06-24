import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import { APP_GET_VERSION } from '@shared/ipc/contract';
import { handleGetVersion } from './ipc/handlers/app';
import { registerIpcHandlers, type IpcHandlerMap } from './ipc/register';
import { installContentSecurityPolicy, type CspOptions } from './security/csp';
import { applyNavigationHardening, buildSecureWebPreferences } from './security/window-hardening';

const moduleDir = dirname(fileURLToPath(import.meta.url));

// electron-vite serves the renderer over http and sets this only in `dev`.
const rendererDevUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const securityOptions: CspOptions =
  rendererDevUrl === undefined ? {} : { devServerUrl: rendererDevUrl };

// The single source of truth for the renderer's capabilities. Each handler is a
// pure, separately-tested function; the registrar adds the sender + zod guards.
const ipcHandlers: IpcHandlerMap = {
  [APP_GET_VERSION]: () => handleGetVersion({ getVersion: () => app.getVersion() }),
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

  applyNavigationHardening(window.webContents);
  window.once('ready-to-show', () => {
    window.show();
  });

  if (rendererDevUrl === undefined) {
    void window.loadFile(join(moduleDir, '../renderer/index.html'));
  } else {
    void window.loadURL(rendererDevUrl);
  }
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // Security guards are installed BEFORE any window loads content (ARCHITECTURE §10).
  installContentSecurityPolicy(session.defaultSession, securityOptions);
  registerIpcHandlers(ipcMain, ipcHandlers, securityOptions);

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

void bootstrap();
