// The main-process entrypoint (ARCHITECTURE §2.3): a THIN shim. It is the ONLY
// module that imports the Electron runtime — it registers the privileged media
// scheme at module load (before `app.whenReady`), builds the {@link MainRuntime}
// seam that adapts every Electron global, and hands the whole dependency graph off
// to the composition root. All wiring — including the load-bearing security-install
// ORDER — lives in `app/composition-root.ts`, where it is unit-tested with a fake
// runtime. This file stays free of business logic so its Electron-global surface
// (which cannot run under Vitest/jsdom) is as small as possible.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, session } from 'electron';
import { MEDIA_PROTOCOL_SCHEME } from '@shared/media';
import { MEDIA_PROTOCOL_PRIVILEGES } from './security/media-protocol';
import { createCompositionRoot, type MainRuntime } from './app/composition-root';

// This module is bundled to `out/main/index.js`, so its own directory is the anchor
// the composition root joins the preload/renderer/worker paths against.
const moduleDir = dirname(fileURLToPath(import.meta.url));

// The custom LOCAL media scheme (#428) must be registered as privileged BEFORE the
// app is ready — so it runs at module load, alongside the other pre-ready setup.
// It is `standard`+`secure`+`stream` (origin semantics + range-streaming for video)
// with `bypassCSP:false`, so media still flows through the locked-down CSP, admitted
// only by the narrow `media-src`/`img-src kawsay-media:` allowance. Nothing here is
// networked: the runtime guard treats the scheme as strictly local (AC-4).
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_PROTOCOL_SCHEME, privileges: MEDIA_PROTOCOL_PRIVILEGES },
]);

// electron-vite serves the renderer over http and sets this only in `dev`.
const rendererDevUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];

// The Electron RUNTIME seam: adapt every Electron global the main process touches
// into the injectable {@link MainRuntime} the composition root wires against.
const runtime: MainRuntime = {
  moduleDir,
  isPackaged: app.isPackaged,
  rendererDevUrl,
  resourcesPath: process.resourcesPath,
  getVersion: () => app.getVersion(),
  getUserDataPath: () => app.getPath('userData'),
  getAppPath: () => app.getAppPath(),
  whenReady: () => app.whenReady(),
  session: session.defaultSession,
  net,
  ipcMain,
  createImageFromPath: (path) => nativeImage.createFromPath(path),
  createBrowserWindow: (options) => new BrowserWindow(options),
  getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
  showOpenDialog: (parent, options) =>
    parent !== undefined ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options),
  getAllWindowsCount: () => BrowserWindow.getAllWindows().length,
  onActivate: (listener) => {
    app.on('activate', listener);
  },
};

const compositionRoot = createCompositionRoot(runtime);

app.on('window-all-closed', () => {
  // Standard macOS behaviour: stay resident until the user explicitly quits.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Full teardown on quit: close the open library and terminate every worker.
  compositionRoot.dispose();
});

void compositionRoot.bootstrap();
