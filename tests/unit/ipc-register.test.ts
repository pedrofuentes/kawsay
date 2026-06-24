import { describe, expect, it, vi } from 'vitest';
import { APP_GET_VERSION } from '@shared/ipc/contract';
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

const trustedEvent = { senderFrame: { url: 'file:///app/out/renderer/index.html' } };

describe('registerIpcHandlers (central IPC trust boundary, ARCHITECTURE §2.3/§2.6)', () => {
  const handlers: IpcHandlerMap = {
    [APP_GET_VERSION]: () => ({ version: '0.1.0' }),
  };

  it('registers a handle() listener for every channel in the contract', () => {
    const ipcMain = fakeIpcMain();
    registerIpcHandlers(ipcMain, handlers);
    expect(ipcMain.listeners.has(APP_GET_VERSION)).toBe(true);
  });

  it('runs the handler and returns its validated response for a trusted sender', async () => {
    const ipcMain = fakeIpcMain();
    registerIpcHandlers(ipcMain, handlers);
    const listener = ipcMain.listeners.get(APP_GET_VERSION);
    expect(listener).toBeDefined();

    await expect(listener?.(trustedEvent, {})).resolves.toEqual({ version: '0.1.0' });
  });

  it('rejects a payload from an untrusted sender origin without calling the handler', async () => {
    const ipcMain = fakeIpcMain();
    const spy = vi.fn(() => ({ version: '0.1.0' }));
    registerIpcHandlers(ipcMain, { [APP_GET_VERSION]: spy });
    const listener = ipcMain.listeners.get(APP_GET_VERSION);

    await expect(listener?.({ senderFrame: { url: 'https://evil.example' } }, {})).rejects.toThrow();
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
    registerIpcHandlers(ipcMain, { [APP_GET_VERSION]: spy });
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
