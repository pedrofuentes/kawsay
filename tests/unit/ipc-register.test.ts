import { describe, expect, it, vi } from 'vitest';
import {
  APP_GET_VERSION,
  CATALOG_GET_TRANSCRIPT,
  CATALOG_SEARCH,
  CATALOG_THUMBNAIL,
  CATALOG_TIMELINE,
  DIALOG_OPEN_DIRECTORY,
  DIALOG_OPEN_FILE,
  IMPORT_CANCEL,
  IMPORT_START,
  LIBRARY_CREATE,
  LIBRARY_OPEN,
  TRANSCRIPTION_CANCEL,
  TRANSCRIPTION_DOWNLOAD_MODEL,
  TRANSCRIPTION_MODEL_STATUS,
  TRANSCRIPTION_START,
  TRANSCRIPTION_STATUS,
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
    expect(ipcMain.listeners.has(APP_GET_VERSION)).toBe(true);
  });

  it('registers a handle() listener for the gated model-download channels', () => {
    const ipcMain = fakeIpcMain();
    registerIpcHandlers(ipcMain, handlers);
    expect(ipcMain.listeners.has(TRANSCRIPTION_DOWNLOAD_MODEL)).toBe(true);
    expect(ipcMain.listeners.has(TRANSCRIPTION_MODEL_STATUS)).toBe(true);
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
});
