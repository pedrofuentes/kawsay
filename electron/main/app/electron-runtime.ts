// The Electron RUNTIME adapter: the single place every Electron global the main
// process touches is wrapped into the injectable {@link MainRuntime} the
// composition root wires against. Kept in its own module (imported only by
// `electron/main/index.ts`) so it can be unit-tested with a mocked `electron` —
// crucially to prove that CONSTRUCTING the runtime touches NO post-`whenReady`
// Electron global (e.g. `session.defaultSession`, which throws before the app is
// ready). Every such global is reached through a DEFERRED thunk, never an eager
// field, so merely building the runtime at module load can never crash the app.

import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, session } from 'electron';
import { MEDIA_PROTOCOL_SCHEME } from '@shared/media';
import { MEDIA_PROTOCOL_PRIVILEGES } from '../security/media-protocol';
import type { MainRuntime } from './composition-root';

/**
 * Register the privileged `kawsay-media:` scheme. MUST run at module load, BEFORE
 * `app.whenReady()` (Electron requires privileged schemes to be declared pre-ready).
 * It is the one piece of Electron wiring that is intentionally eager; it touches no
 * post-ready global (`registerSchemesAsPrivileged` is available immediately).
 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_PROTOCOL_SCHEME, privileges: MEDIA_PROTOCOL_PRIVILEGES },
  ]);
}

/**
 * Build the production {@link MainRuntime} by adapting the Electron globals.
 *
 * INVARIANT: constructing this object accesses NO Electron global that is only
 * valid after `app.whenReady()`. `app.isPackaged` / `process.resourcesPath` are
 * constants available at module load; everything else — above all
 * `session.defaultSession` — is a DEFERRED thunk the composition root only calls
 * from inside `bootstrap()`, after `await app.whenReady()`. (An eager
 * `session.defaultSession` read here throws "Session can only be received when app
 * is ready" and crashes the app on boot, before any security guard installs.)
 *
 * @param moduleDir the directory of the built main entry (`out/main`), derived from
 *   the entry's own `import.meta.url` — the anchor for preload/renderer/worker paths.
 */
export function createElectronRuntime(moduleDir: string): MainRuntime {
  // electron-vite serves the renderer over http and sets this only in `dev`.
  const rendererDevUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];

  return {
    moduleDir,
    isPackaged: app.isPackaged,
    rendererDevUrl,
    resourcesPath: process.resourcesPath,
    getVersion: () => app.getVersion(),
    getUserDataPath: () => app.getPath('userData'),
    getAppPath: () => app.getAppPath(),
    whenReady: () => app.whenReady(),
    // DEFERRED: reading `session.defaultSession` before the app is ready throws.
    getSession: () => session.defaultSession,
    net,
    ipcMain,
    createImageFromPath: (path) => nativeImage.createFromPath(path),
    createBrowserWindow: (options) => new BrowserWindow(options),
    getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
    showOpenDialog: (parent, options) =>
      parent !== undefined
        ? dialog.showOpenDialog(parent, options)
        : dialog.showOpenDialog(options),
    getAllWindowsCount: () => BrowserWindow.getAllWindows().length,
    onActivate: (listener) => {
      app.on('activate', listener);
    },
  };
}
