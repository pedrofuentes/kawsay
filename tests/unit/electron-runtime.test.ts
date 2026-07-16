import { beforeEach, describe, expect, it, vi } from 'vitest';

// This suite exercises the REAL Electron-runtime adapter (`electron/main/app/
// electron-runtime.ts`) with a mocked `electron`, to lock the boot-safety invariant
// a fake-`MainRuntime` test can NEVER catch: constructing the runtime must touch NO
// post-`whenReady` Electron global. The canonical trap is `session.defaultSession`,
// which throws "Session can only be received when app is ready" before the app is
// ready — an eager read there crashes the app on EVERY launch, before any security
// guard installs (this is the exact regression Sentinel rejected).

// Shared, mutable spy state for the mocked `electron` module (hoisted with the mock).
const electronState = vi.hoisted(() => ({
  defaultSessionAccesses: 0,
  throwOnDefaultSessionAccess: false,
  sessionSentinel: { id: 'guarded-default-session' } as Record<string, unknown>,
}));

vi.mock('electron', () => {
  function BrowserWindowMock(this: unknown): void {
    /* a constructible stand-in; the runtime only ever `new`s it */
  }
  BrowserWindowMock.getFocusedWindow = vi.fn(() => null);
  BrowserWindowMock.getAllWindows = vi.fn(() => [] as unknown[]);
  return {
    app: {
      isPackaged: false,
      getVersion: vi.fn(() => '1.2.3'),
      getPath: vi.fn(() => '/user-data'),
      getAppPath: vi.fn(() => '/app-root'),
      whenReady: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
    },
    BrowserWindow: BrowserWindowMock,
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
    ipcMain: { handle: vi.fn() },
    nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => true })) },
    net: { request: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn() },
    session: {
      // A getter, exactly like Electron's: accessing it before ready throws. We count
      // every access so a test can prove construction never reads it.
      get defaultSession() {
        electronState.defaultSessionAccesses++;
        if (electronState.throwOnDefaultSessionAccess) {
          throw new Error('Session can only be received when app is ready');
        }
        return electronState.sessionSentinel;
      },
    },
  };
});

// Imported AFTER the mock is registered.
import { protocol } from 'electron';
import { createElectronRuntime, registerPrivilegedSchemes } from '../../electron/main/app/electron-runtime';

beforeEach(() => {
  electronState.defaultSessionAccesses = 0;
  electronState.throwOnDefaultSessionAccess = false;
  vi.clearAllMocks();
});

describe('createElectronRuntime — boot-safety (session deferral)', () => {
  it('does NOT read session.defaultSession while constructing the runtime', () => {
    const runtime = createElectronRuntime('/app/out/main');

    // The whole point: building the MainRuntime object touched no post-ready global.
    expect(electronState.defaultSessionAccesses).toBe(0);
    expect(runtime.moduleDir).toBe('/app/out/main');
  });

  it('reads session.defaultSession ONLY when getSession() is called, and returns it', () => {
    const runtime = createElectronRuntime('/app/out/main');
    expect(electronState.defaultSessionAccesses).toBe(0);

    const guarded = runtime.getSession();

    expect(electronState.defaultSessionAccesses).toBe(1);
    expect(guarded).toBe(electronState.sessionSentinel);
  });

  it('still constructs without throwing when defaultSession is not yet available (pre-ready)', () => {
    // Simulate the real pre-`whenReady` Electron behaviour: the getter throws.
    electronState.throwOnDefaultSessionAccess = true;

    // Construction must be crash-free (this is what boots the app)…
    let runtime!: ReturnType<typeof createElectronRuntime>;
    expect(() => {
      runtime = createElectronRuntime('/app/out/main');
    }).not.toThrow();

    // …and the throw only surfaces if someone reads the session too early.
    expect(() => runtime.getSession()).toThrow('Session can only be received when app is ready');
  });

  it('exposes only module-load-safe constants eagerly (isPackaged, resourcesPath)', () => {
    const runtime = createElectronRuntime('/app/out/main');
    expect(runtime.isPackaged).toBe(false);
    // resourcesPath is passed through verbatim (Electron injects it on `process`;
    // in a plain Node test host it is undefined — either way, no session access).
    expect(runtime.resourcesPath).toBe(process.resourcesPath);
    // Reading those constants did not trip the session getter either.
    expect(electronState.defaultSessionAccesses).toBe(0);
  });
});

describe('createElectronRuntime — deferred thunks delegate to Electron', () => {
  it('routes every accessor to its Electron global', async () => {
    const runtime = createElectronRuntime('/app/out/main');

    expect(runtime.getVersion()).toBe('1.2.3');
    expect(runtime.getUserDataPath()).toBe('/user-data');
    expect(runtime.getAppPath()).toBe('/app-root');
    await expect(runtime.whenReady()).resolves.toBeUndefined();
    expect(runtime.getFocusedWindow()).toBeNull();
    expect(runtime.getAllWindowsCount()).toBe(0);
    expect(() => runtime.createImageFromPath('/x')).not.toThrow();
    expect(() => runtime.createBrowserWindow({})).not.toThrow();
    await expect(runtime.showOpenDialog(undefined, {})).resolves.toEqual({
      canceled: true,
      filePaths: [],
    });
    expect(() => runtime.onActivate(() => {})).not.toThrow();
    // rendererDevUrl is undefined in a non-packaged run with the env var unset.
    expect(runtime.rendererDevUrl).toBeUndefined();
  });
});

describe('registerPrivilegedSchemes', () => {
  it('declares the kawsay-media scheme as privileged (pre-ready, no session access)', () => {
    registerPrivilegedSchemes();

    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
    const registered = vi.mocked(protocol.registerSchemesAsPrivileged).mock.calls[0]?.[0] as Array<{
      scheme: string;
    }>;
    expect(registered.map((entry) => entry.scheme)).toContain('kawsay-media');
    // Declaring privileged schemes must not touch the session either.
    expect(electronState.defaultSessionAccesses).toBe(0);
  });
});
