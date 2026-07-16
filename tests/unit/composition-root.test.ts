import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, NativeImage, Net, Session } from 'electron';
import { createCompositionRoot, type MainRuntime } from '../../electron/main/app/composition-root';

// The load-bearing security-install ORDER inside bootstrap() (ARCHITECTURE §2.2/§6.1):
// the CSP, the zero-egress network guard, and the `kawsay-media:` protocol handler
// MUST install on `session.defaultSession` BEFORE any BrowserWindow is created or
// any renderer content is loaded — and the IPC handlers register before the window
// too. This test drives the REAL composition root with a fake {@link MainRuntime}
// and records the order in which the underlying session/ipc/window operations fire,
// so a future refactor that reorders bootstrap fails here.

/** The ordered log of security/wiring milestones, in the order bootstrap triggers them. */
type Milestone =
  | 'install-csp'
  | 'install-network-guard'
  | 'media-protocol'
  | 'register-ipc-handlers'
  | 'create-window'
  | 'load-renderer';

/** A recording fake of the one guarded session, with the exact structural shape the
 *  security installers reach into (webRequest + protocol.handle). */
interface FakeSession {
  webRequest: {
    onHeadersReceived: ReturnType<typeof vi.fn>;
    onBeforeRequest: ReturnType<typeof vi.fn>;
  };
  protocol: { handle: ReturnType<typeof vi.fn> };
}

/** A recording fake window exposing only what the composition root touches. */
interface FakeWindow {
  webContents: {
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    getURL: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
  once: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
}

interface Harness {
  runtime: MainRuntime;
  calls: Milestone[];
  session: FakeSession;
  window: FakeWindow;
  createBrowserWindow: ReturnType<typeof vi.fn>;
  onActivate: ReturnType<typeof vi.fn>;
}

function createHarness(overrides: { rendererDevUrl?: string } = {}): Harness {
  const calls: Milestone[] = [];

  const window: FakeWindow = {
    // applyNavigationHardening touches these; loadRenderer/emit touch send/loadFile.
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      getURL: vi.fn(() => ''),
      send: vi.fn(),
    },
    once: vi.fn(),
    on: vi.fn(),
    show: vi.fn(),
    loadFile: vi.fn(async () => {
      calls.push('load-renderer');
    }),
    loadURL: vi.fn(async () => {
      calls.push('load-renderer');
    }),
  };

  const session: FakeSession = {
    webRequest: {
      onHeadersReceived: vi.fn(() => {
        calls.push('install-csp');
      }),
      onBeforeRequest: vi.fn(() => {
        calls.push('install-network-guard');
      }),
    },
    protocol: {
      handle: vi.fn(() => {
        calls.push('media-protocol');
      }),
    },
  };

  let ipcRegistered = false;
  const ipcMain: MainRuntime['ipcMain'] = {
    handle: vi.fn(() => {
      // registerIpcHandlers loops over every channel; record only the first call.
      if (!ipcRegistered) {
        ipcRegistered = true;
        calls.push('register-ipc-handlers');
      }
    }),
  };

  const createBrowserWindow = vi.fn(() => {
    calls.push('create-window');
    return window as unknown as BrowserWindow;
  });
  const onActivate = vi.fn();

  // Typed as MainRuntime so the shape is structurally checked; only the leaf Electron
  // objects (session/net/window/image) are cast, since a full Electron double is not
  // needed to exercise the wiring the composition root actually calls.
  const runtime: MainRuntime = {
    moduleDir: '/app/out/main',
    isPackaged: true,
    rendererDevUrl: overrides.rendererDevUrl,
    resourcesPath: '/app/resources',
    getVersion: () => '9.9.9',
    getUserDataPath: () => '/tmp/kawsay-userdata',
    getAppPath: () => '/app',
    whenReady: () => Promise.resolve(),
    getSession: () => session as unknown as Session,
    net: { request: vi.fn() } as unknown as Net,
    ipcMain,
    createImageFromPath: vi.fn(() => ({}) as unknown as NativeImage),
    createBrowserWindow,
    getFocusedWindow: () => null,
    showOpenDialog: vi.fn(async () => ({ canceled: true as const, filePaths: [] })),
    getAllWindowsCount: () => 0,
    onActivate,
  };

  return { runtime, calls, session, window, createBrowserWindow, onActivate };
}

describe('composition root — security-install ordering', () => {
  beforeEach(() => {
    // The composition root logs to console on some paths; keep the test output calm.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('installs CSP, the network guard, then the media protocol — all before any window/renderer load', async () => {
    const { runtime, calls } = createHarness();

    await createCompositionRoot(runtime).bootstrap();

    // The exact production sequence, in order.
    expect(calls).toEqual([
      'install-csp',
      'install-network-guard',
      'media-protocol',
      'register-ipc-handlers',
      'create-window',
      'load-renderer',
    ]);
  });

  it('installs every guard + the media protocol BEFORE the window is created or content loads', async () => {
    const { runtime, calls } = createHarness();

    await createCompositionRoot(runtime).bootstrap();

    const csp = calls.indexOf('install-csp');
    const guard = calls.indexOf('install-network-guard');
    const protocol = calls.indexOf('media-protocol');
    const ipc = calls.indexOf('register-ipc-handlers');
    const window = calls.indexOf('create-window');
    const renderer = calls.indexOf('load-renderer');

    // Guards + protocol come first, in this order.
    expect(csp).toBeLessThan(guard);
    expect(guard).toBeLessThan(protocol);
    // …and ALL of them strictly precede the window creation and any renderer load.
    for (const guardStep of [csp, guard, protocol]) {
      expect(guardStep).toBeLessThan(window);
      expect(guardStep).toBeLessThan(renderer);
    }
    // The IPC handlers register before the window too, and the window before content.
    expect(protocol).toBeLessThan(ipc);
    expect(ipc).toBeLessThan(window);
    expect(window).toBeLessThan(renderer);
  });

  it('binds the CSP + network guard + media protocol to the SAME guarded default session', async () => {
    const { runtime, session } = createHarness();

    await createCompositionRoot(runtime).bootstrap();

    expect(session.webRequest.onHeadersReceived).toHaveBeenCalledTimes(1);
    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    // The media protocol is registered under the `kawsay-media:` scheme, once.
    expect(session.protocol.handle).toHaveBeenCalledTimes(1);
    expect(session.protocol.handle.mock.calls[0]?.[0]).toBe('kawsay-media');
  });

  it('creates exactly one window and loads it via loadFile in a packaged (production) build', async () => {
    const { runtime, createBrowserWindow, window } = createHarness();

    await createCompositionRoot(runtime).bootstrap();

    expect(createBrowserWindow).toHaveBeenCalledTimes(1);
    // Production loads the packaged file entry, never a dev-server URL.
    expect(window.loadFile).toHaveBeenCalledTimes(1);
    expect(window.loadURL).not.toHaveBeenCalled();
  });

  it('registers an activate handler and re-opens a window when none remain (macOS)', async () => {
    const { runtime, calls, onActivate } = createHarness();

    await createCompositionRoot(runtime).bootstrap();

    expect(onActivate).toHaveBeenCalledTimes(1);
    const activate = onActivate.mock.calls[0]?.[0] as () => void;
    calls.length = 0;
    activate();
    expect(calls).toContain('create-window');
  });
});

describe('composition root — dev vs packaged renderer load', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the dev-server URL (not the file) when a renderer dev URL is present', async () => {
    const { runtime, window } = createHarness({ rendererDevUrl: 'http://localhost:5173' });

    await createCompositionRoot(runtime).bootstrap();

    expect(window.loadURL).toHaveBeenCalledTimes(1);
    expect(window.loadFile).not.toHaveBeenCalled();
  });
});
