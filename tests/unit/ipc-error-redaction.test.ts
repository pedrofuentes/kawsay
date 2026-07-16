import { describe, expect, it, vi } from 'vitest';
import { APP_GET_VERSION, type IpcChannel } from '@shared/ipc/contract';
import {
  IPC_ERROR_TAG,
  IpcError,
  decodeIpcErrorMessage,
  isIpcError,
} from '@shared/ipc/error-envelope';
import {
  registerIpcHandlers,
  type IpcHandleListener,
  type IpcHandlerMap,
} from '../../electron/main/ipc/register';
import { createValidatedInvoke } from '../../electron/preload/invoke';

// A filesystem path + item id baked into a thrown error's message, so the test can
// PROVE neither ever reaches the renderer nor the logger's projected output.
const PII_PATH = '/Users/alice/Memories/private.sqlite';
const PII_ID = 'item-7f3c-secret';
const PII_MESSAGE = `no such item: ${PII_ID} at ${PII_PATH}`;

const trustedSenderOptions = {
  rendererEntryPath: '/app/out/renderer/index.html',
  platform: 'darwin' as const,
};
const trustedEvent = { senderFrame: { url: 'file:///app/out/renderer/index.html' } };

/** A handler map whose app:getVersion throws a PII-laden error; every other channel
 *  is an unused no-op (this test only drives app:getVersion). */
function boomHandlers(): IpcHandlerMap {
  return new Proxy(
    {},
    {
      get(_t, channel: string) {
        if (channel === APP_GET_VERSION) {
          return () => {
            throw new Error(PII_MESSAGE);
          };
        }
        return () => ({});
      },
    },
  ) as unknown as IpcHandlerMap;
}

function wire() {
  const listeners = new Map<string, IpcHandleListener>();
  const ipcMain = {
    handle(channel: string, listener: IpcHandleListener) {
      listeners.set(channel, listener);
    },
  };
  registerIpcHandlers(ipcMain, boomHandlers(), trustedSenderOptions);
  const listener = listeners.get(APP_GET_VERSION);
  if (listener === undefined) throw new Error('listener not registered');

  // What actually crossed the boundary (the value ipcRenderer.invoke rejects with —
  // the redacted Error main threw). The preload then recovers a typed IpcError.
  let crossed: unknown;
  const rawInvoke = async (_channel: string, payload: unknown): Promise<unknown> => {
    try {
      return await listener(trustedEvent, payload);
    } catch (rejected) {
      crossed = rejected;
      throw rejected;
    }
  };
  const invoke = createValidatedInvoke(rawInvoke);
  return { invoke, getCrossed: () => crossed };
}

describe('THE INVARIANT (#440): no raw message/stack crosses IPC to the renderer', () => {
  it('a PII-laden handler throw reaches the renderer as ONLY a redacted {code, name}', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { invoke, getCrossed } = wire();

      const rejection = await invoke(APP_GET_VERSION as IpcChannel, {} as never).then(
        () => {
          throw new Error('expected the invoke to reject');
        },
        (e: unknown) => e,
      );

      // 1) What CROSSED the boundary is a redacted Error: its message decodes to a
      //    {code, name} payload ONLY, and neither message nor the scrubbed stack
      //    carries any of the PII from the original throw.
      const crossed = getCrossed();
      expect(crossed).toBeInstanceOf(Error);
      const payload = decodeIpcErrorMessage((crossed as Error).message);
      expect(payload).toEqual({ code: 'ERR_IPC_HANDLER_FAULT', name: 'Error' });
      const crossedSerialized = `${(crossed as Error).message}\n${(crossed as Error).stack ?? ''}`;
      expect(crossedSerialized).not.toContain(PII_ID);
      expect(crossedSerialized).not.toContain(PII_PATH);
      expect(crossedSerialized).not.toContain('no such item');
      // The ONLY thing in the message beyond the tag is the JSON {code, name}.
      expect((crossed as Error).message.startsWith(IPC_ERROR_TAG)).toBe(true);

      // 2) The renderer receives a typed IpcError (code + origin name), NOT raw text.
      expect(isIpcError(rejection)).toBe(true);
      const ipcError = rejection as IpcError;
      expect(ipcError.code).toBe('ERR_IPC_HANDLER_FAULT');
      expect(ipcError.originName).toBe('Error');
      const rendererSerialized = `${ipcError.message}\n${ipcError.stack ?? ''}`;
      expect(rendererSerialized).not.toContain(PII_ID);
      expect(rendererSerialized).not.toContain(PII_PATH);
      expect(rendererSerialized).not.toContain('no such item');

      // 3) The logger's local diagnostic also carries no message/stack.
      const loggerSerialized = JSON.stringify(errorSpy.mock.calls);
      expect(loggerSerialized).not.toContain(PII_ID);
      expect(loggerSerialized).not.toContain(PII_PATH);
      expect(loggerSerialized).not.toContain('no such item');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
