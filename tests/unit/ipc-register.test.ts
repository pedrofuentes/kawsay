import { describe, expect, it, vi } from 'vitest';
import {
  APP_GET_VERSION,
  CATALOG_GET_TRANSCRIPT,
  CATALOG_SEARCH,
  CATALOG_THUMBNAIL,
  CATALOG_TIMELINE,
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
  ipcContract,
} from '@shared/ipc/contract';
import {
  registerIpcHandlers,
  type IpcHandlerMap,
  type IpcHandleListener,
} from '../../electron/main/ipc/register';

function fakeIpcMain() {
  const listeners = new Map<string, IpcHandleListener>();
  return {
    listeners,
    handle(channel: string, listener: IpcHandleListener) {
      listeners.set(channel, listener);
    },
  };
}

// Trivial, correctly-typed stubs for the non-app channels, so the handler map
// satisfies the (now multi-channel) contract. These tests only exercise the
// app:getVersion listener — the stubs are never invoked.
const otherHandlers = {
  [LIBRARY_CREATE]: () => ({ root: '/x', name: 'x', createdAt: 'x', schemaVersion: 1 }),
  [LIBRARY_OPEN]: () => ({ root: '/x', name: 'x', createdAt: 'x', schemaVersion: 1 }),
  [CATALOG_TIMELINE]: () => ({ items: [], nextCursor: null }),
  [CATALOG_SEARCH]: () => ({ items: [], total: 0 }),
  [CATALOG_THUMBNAIL]: () => null,
  [IMPORT_START]: () => ({ jobId: '00000000-0000-0000-0000-000000000000' }),
  [IMPORT_CANCEL]: () => ({ cancelled: false }),
  [DIALOG_OPEN_DIRECTORY]: () => null,
  [DIALOG_OPEN_FILE]: () => null,
  [TRANSCRIPTION_DOWNLOAD_MODEL]: () => ({ status: 'already-present' as const }),
  [TRANSCRIPTION_MODEL_STATUS]: () => ({ ready: false }),
  [SMART_SEARCH_DOWNLOAD_MODEL]: () => ({ outcome: 'download-started' as const }),
  [SMART_SEARCH_MODEL_STATUS]: () => ({ optedIn: false, modelReady: false, offered: false }),
  [TRANSCRIPTION_START]: () => ({
    outcome: 'idle' as const,
    reason: null,
    counts: { total: 0, transcribed: 0, failed: 0, skipped: 0, inFlight: 0 },
  }),
  [TRANSCRIPTION_STATUS]: () => ({
    state: 'idle' as const,
    counts: { total: 0, transcribed: 0, failed: 0, skipped: 0, inFlight: 0 },
    lastItem: null,
  }),
  [TRANSCRIPTION_CANCEL]: () => ({ cancelled: false }),
  [CATALOG_GET_TRANSCRIPT]: () => ({
    status: 'pending' as const,
    language: null,
    text: null,
    segments: [],
  }),
  [CATEGORIZE_STATUS]: () => ({ optedIn: false, offered: false }),
  [CATEGORIZE_SET_CONSENT]: () => ({ optedIn: false }),
  [CATEGORIZE_LIST_FOR_ITEM]: () => [],
  [CATEGORIZE_APPLY_CORRECTION]: () => [],
  [CATEGORIZE_START]: () => ({
    outcome: 'idle' as const,
    reason: null,
    counts: { categorized: 0, skipped: 0, failed: 0, inFlight: 0 },
  }),
  [CATEGORIZE_CANCEL]: () => ({ cancelled: false }),
  [SUGGESTIONS_LIST]: () => ({ suggestions: [], collections: [] }),
  [SUGGESTIONS_ACCEPT]: () => ({ suggestions: [], collections: [] }),
  [SUGGESTIONS_MERGE]: () => ({ suggestions: [], collections: [] }),
  [SUGGESTIONS_DISMISS]: () => ({ suggestions: [], collections: [] }),
} satisfies Omit<IpcHandlerMap, typeof APP_GET_VERSION>;

const trustedEvent = { senderFrame: { url: 'file:///app/out/renderer/index.html' } };
const rendererEntryPath = '/app/out/renderer/index.html';
// POSIX fixtures — pin the platform so the sender-origin trust check runs under
// POSIX path semantics on any host, including the Windows CI runner (issue #34).
// Without this, `process.platform === 'win32'` on CI treats the drive-less
// `file:///app/...` path as an invalid Windows path and rejects the legit sender.
const trustedSenderOptions = { rendererEntryPath, platform: 'darwin' as const };

describe('registerIpcHandlers (central IPC trust boundary, ARCHITECTURE §2.3/§2.6)', () => {
  const handlers: IpcHandlerMap = {
    ...otherHandlers,
    [APP_GET_VERSION]: () => ({ version: '0.1.0' }),
  };

  it('registers a handle() listener for every channel in the contract', () => {
    const ipcMain = fakeIpcMain();
    registerIpcHandlers(ipcMain, handlers);
    expect([...ipcMain.listeners.keys()].sort()).toEqual(Object.keys(ipcContract).sort());
  });

  it('registers a handle() listener for the gated model-download channels', () => {
    const ipcMain = fakeIpcMain();
    registerIpcHandlers(ipcMain, handlers);
    expect(ipcMain.listeners.has(TRANSCRIPTION_DOWNLOAD_MODEL)).toBe(true);
    expect(ipcMain.listeners.has(TRANSCRIPTION_MODEL_STATUS)).toBe(true);
  });

  it('registers a handle() listener for the smart-search opt-in channels (M4-1b)', () => {
    const ipcMain = fakeIpcMain();
    registerIpcHandlers(ipcMain, handlers);
    expect(ipcMain.listeners.has(SMART_SEARCH_DOWNLOAD_MODEL)).toBe(true);
    expect(ipcMain.listeners.has(SMART_SEARCH_MODEL_STATUS)).toBe(true);
  });

  it('registers a handle() listener for the gated transcription-run channels (#157)', () => {
    const ipcMain = fakeIpcMain();
    registerIpcHandlers(ipcMain, handlers);
    expect(ipcMain.listeners.has(TRANSCRIPTION_START)).toBe(true);
    expect(ipcMain.listeners.has(TRANSCRIPTION_STATUS)).toBe(true);
    expect(ipcMain.listeners.has(TRANSCRIPTION_CANCEL)).toBe(true);
  });

  it('registers a handle() listener for the per-item transcript read channel (#136)', () => {
    const ipcMain = fakeIpcMain();
    registerIpcHandlers(ipcMain, handlers);
    expect(ipcMain.listeners.has(CATALOG_GET_TRANSCRIPT)).toBe(true);
  });

  it('runs the handler and returns its validated response for a trusted sender', async () => {
    const ipcMain = fakeIpcMain();
    registerIpcHandlers(ipcMain, handlers, trustedSenderOptions);
    const listener = ipcMain.listeners.get(APP_GET_VERSION);
    expect(listener).toBeDefined();

    await expect(listener?.(trustedEvent, {})).resolves.toEqual({ version: '0.1.0' });
  });

  it('rejects a non-app file:// sender (attacker-dropped HTML) without calling the handler', async () => {
    const ipcMain = fakeIpcMain();
    const spy = vi.fn(() => ({ version: '0.1.0' }));
    registerIpcHandlers(
      ipcMain,
      { ...otherHandlers, [APP_GET_VERSION]: spy },
      trustedSenderOptions,
    );
    const listener = ipcMain.listeners.get(APP_GET_VERSION);

    await expect(
      listener?.({ senderFrame: { url: 'file:///tmp/evil/attacker.html' } }, {}),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a payload from an untrusted sender origin without calling the handler', async () => {
    const ipcMain = fakeIpcMain();
    const spy = vi.fn(() => ({ version: '0.1.0' }));
    registerIpcHandlers(ipcMain, { ...otherHandlers, [APP_GET_VERSION]: spy });
    const listener = ipcMain.listeners.get(APP_GET_VERSION);

    await expect(
      listener?.({ senderFrame: { url: 'https://evil.example' } }, {}),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects when there is no sender frame at all', async () => {
    const ipcMain = fakeIpcMain();
    registerIpcHandlers(ipcMain, handlers);
    const listener = ipcMain.listeners.get(APP_GET_VERSION);

    await expect(listener?.({ senderFrame: null }, {})).rejects.toThrow();
  });

  it('re-validates the request in main and rejects unexpected payload keys', async () => {
    const ipcMain = fakeIpcMain();
    const spy = vi.fn(() => ({ version: '0.1.0' }));
    registerIpcHandlers(
      ipcMain,
      { ...otherHandlers, [APP_GET_VERSION]: spy },
      trustedSenderOptions,
    );
    const listener = ipcMain.listeners.get(APP_GET_VERSION);

    await expect(listener?.(trustedEvent, { rogue: true })).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('honours the dev-server origin when configured', async () => {
    const ipcMain = fakeIpcMain();
    registerIpcHandlers(ipcMain, handlers, { devServerUrl: 'http://localhost:5173' });
    const listener = ipcMain.listeners.get(APP_GET_VERSION);

    await expect(
      listener?.({ senderFrame: { url: 'http://localhost:5173/index.html' } }, {}),
    ).resolves.toEqual({ version: '0.1.0' });
  });

  it('logs a local diagnostic (no telemetry) when a handler throws, and still propagates (#373)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // A handler business-logic fault (e.g. acceptAndMerge on a stale collection id)
      // whose message deliberately carries an id so the test can prove it never leaks.
      const boom = vi.fn(() => {
        throw new Error('stale intoCollectionId 7f3c-secret');
      });
      const ipcMain = fakeIpcMain();
      registerIpcHandlers(
        ipcMain,
        { ...otherHandlers, [APP_GET_VERSION]: boom },
        trustedSenderOptions,
      );
      const listener = ipcMain.listeners.get(APP_GET_VERSION);

      // The error STILL propagates to the renderer (the trust-boundary contract is
      // unchanged — the shim only observes, it does not swallow).
      await expect(listener?.(trustedEvent, {})).rejects.toThrow('stale intoCollectionId');
      expect(boom).toHaveBeenCalledTimes(1);

      // ...but a main-process handler fault no longer leaves ZERO local trace: exactly
      // one diagnostic is emitted, carrying the kawsay prefix and naming the channel.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const call = errorSpy.mock.calls[0];
      expect(String(call[0])).toContain('[kawsay]');
      // Constant %s format string (Semgrep unsafe-formatstring / CWE-134): the channel is
      // passed as an argument (not interpolated), so it is named in the diagnostic call.
      expect(call).toContain(APP_GET_VERSION);
      // Local-only + privacy: only a name/code diagnostic crosses the line — the raw
      // error message (which can carry ids / paths / item text) MUST NOT be logged.
      expect(JSON.stringify(call)).not.toContain('secret');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('registers exactly the contract channel set — the log shim adds no channel (#373)', () => {
    const ipcMain = fakeIpcMain();
    registerIpcHandlers(ipcMain, handlers, trustedSenderOptions);
    expect([...ipcMain.listeners.keys()].sort()).toEqual(Object.keys(ipcContract).sort());
  });
});
