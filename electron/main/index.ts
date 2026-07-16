// The main-process entrypoint (ARCHITECTURE §2.3): a THIN shim. It registers the
// privileged media scheme at module load (before `app.whenReady`), builds the
// {@link MainRuntime} seam that adapts every Electron global, and hands the whole
// dependency graph off to the composition root. All wiring — including the
// load-bearing security-install ORDER — lives in `app/composition-root.ts`, where it
// is unit-tested with a fake runtime; the Electron-global adaptation lives in
// `app/electron-runtime.ts`, unit-tested with a mocked `electron`. This file keeps
// only the two things that MUST run at the entry: computing the entry directory from
// `import.meta.url`, and the app-lifecycle hooks.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import { createElectronRuntime, registerPrivilegedSchemes } from './app/electron-runtime';
import { createCompositionRoot } from './app/composition-root';

// This module is bundled to `out/main/index.js`, so its own directory is the anchor
// the composition root joins the preload/renderer/worker paths against.
const moduleDir = dirname(fileURLToPath(import.meta.url));

// The custom LOCAL media scheme (#428) must be registered as privileged BEFORE the
// app is ready — so it runs at module load, alongside the other pre-ready setup.
registerPrivilegedSchemes();

// The Electron RUNTIME seam. Constructing it touches NO post-`whenReady` global
// (session/screen/…) — those are deferred thunks — so the app can never crash here.
const compositionRoot = createCompositionRoot(createElectronRuntime(moduleDir));

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
