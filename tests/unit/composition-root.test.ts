import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCompositionRoot, type MainRuntime } from '../../electron/main/app/composition-root';

// The load-bearing security-install ORDER inside bootstrap() (ARCHITECTURE §10):
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

interface Harness {
  runtime: MainRuntime;
  calls: Milestone[];
}

function createHarness(overrides: { rendererDevUrl?: string } = {}): Harness {
  const calls: Milestone[] = [];

  const webContents = {
    // applyNavigationHardening touches these; loadRenderer/emit touch send/loadFile.
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    getURL: vi.fn(() => ''),
    send: vi.fn(),
  };
  const window = {
    webContents,
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

  const session = {
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
  const ipcMain = {
    handle: vi.fn(() => {
      // registerIpcHandlers loops over every channel; record only the first call.
      if (!ipcRegistered) {
        ipcRegistered = true;
        calls.push('register-ipc-handlers');
      }
    }),
  };

  const runtime = {
    moduleDir: '/app/out/main',
    isPackaged: true,
    rendererDevUrl: overrides.rendererDevUrl,
    resourcesPath: '/app/resources',
    getVersion: () => '9.9.9',
    getUserDataPath: () => '/tmp/kawsay-userdata',
    getAppPath: () => '/app',
    whenReady: () => Promise.resolve(),
    session,
    net: { request: vi.fn() },
    ipcMain,
    createImageFromPath: vi.fn(),
    createBrowserWindow: vi.fn(() => {
      calls.push('create-window');
      return window;
    }),
    getFocusedWindow: () => null,
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    getAllWindowsCount: () => 0,
    onActivate: vi.fn(),
  } as unknown as MainRuntime;

  return { runtime, calls };
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
    const { runtime } = createHarness();

    await createCompositionRoot(runtime).bootstrap();

    const session = runtime.session as unknown as {
      webRequest: { onHeadersReceived: ReturnType<typeof vi.fn>; onBeforeRequest: ReturnType<typeof vi.fn> };
      protocol: { handle: ReturnType<typeof vi.fn> };
    };
    expect(session.webRequest.onHeadersReceived).toHaveBeenCalledTimes(1);
    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    // The media protocol is registered under the `kawsay-media:` scheme, once.
    expect(session.protocol.handle).toHaveBeenCalledTimes(1);
    expect(session.protocol.handle.mock.calls[0]?.[0]).toBe('kawsay-media');
  });

  it('creates exactly one window and loads it via loadFile in a packaged (production) build', async () => {
    const { runtime } = createHarness();

    await createCompositionRoot(runtime).bootstrap();

    const create = runtime.createBrowserWindow as unknown as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(1);
    const window = create.mock.results[0]?.value as {
      loadFile: ReturnType<typeof vi.fn>;
      loadURL: ReturnType<typeof vi.fn>;
    };
    // Production loads the packaged file entry, never a dev-server URL.
    expect(window.loadFile).toHaveBeenCalledTimes(1);
    expect(window.loadURL).not.toHaveBeenCalled();
  });

  it('registers an activate handler and re-opens a window when none remain (macOS)', async () => {
    const { runtime, calls } = createHarness();

    await createCompositionRoot(runtime).bootstrap();

    const onActivate = runtime.onActivate as unknown as ReturnType<typeof vi.fn>;
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
    const { runtime } = createHarness({ rendererDevUrl: 'http://localhost:5173' });

    await createCompositionRoot(runtime).bootstrap();

    const create = runtime.createBrowserWindow as unknown as ReturnType<typeof vi.fn>;
    const window = create.mock.results[0]?.value as {
      loadFile: ReturnType<typeof vi.fn>;
      loadURL: ReturnType<typeof vi.fn>;
    };
    expect(window.loadURL).toHaveBeenCalledTimes(1);
    expect(window.loadFile).not.toHaveBeenCalled();
  });
});
