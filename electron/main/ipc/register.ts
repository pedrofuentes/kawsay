import type { z } from 'zod';
import { ipcContract, type IpcChannel, type IpcResponse } from '@shared/ipc/contract';
import { IPC_ERROR_CODES, makeIpcError } from '@shared/ipc/error-envelope';
import { log } from '../log';
import { isTrustedSenderUrl, type TrustedSenderOptions } from './sender';

/** The parsed (post-validation) request shape a channel handler receives. */
export type IpcRequestParsed<C extends IpcChannel> = z.output<(typeof ipcContract)[C]['request']>;

/** One business handler per channel: parsed request in, contract response out. */
export type ChannelHandler<C extends IpcChannel> = (
  request: IpcRequestParsed<C>,
) => IpcResponse<C> | Promise<IpcResponse<C>>;

/** Exactly one handler per contract channel — enforced by the mapped type. */
export type IpcHandlerMap = {
  readonly [C in IpcChannel]: ChannelHandler<C>;
};

/** Structural views of the Electron objects we touch, so this module
 *  unit-tests without an Electron runtime. */
export interface IpcInvokeEventLike {
  readonly senderFrame: { readonly url: string } | null;
}
export type IpcHandleListener = (event: IpcInvokeEventLike, payload: unknown) => Promise<unknown>;
export interface IpcMainLike {
  handle(channel: string, listener: IpcHandleListener): void;
}

/**
 * Wire every contract channel onto `ipcMain` behind one uniform trust boundary
 * (ARCHITECTURE §2.3, §2.6): (1) reject untrusted sender origins, (2) re-validate
 * the request with zod, (3) run the handler, (4) validate the response with zod.
 * Centralising this means no channel can be added that skips a step.
 *
 * Per-channel type safety is guaranteed by `IpcHandlerMap` at the call site; the
 * loop dispatches dynamically over the validated payload (`as never`), since the
 * zod schemas — not the static types — are the runtime trust boundary here.
 */
export function registerIpcHandlers(
  ipcMain: IpcMainLike,
  handlers: IpcHandlerMap,
  options: TrustedSenderOptions = {},
): void {
  for (const channel of ipcChannels()) {
    const { request: requestSchema, response: responseSchema } = ipcContract[channel];
    const handler = handlers[channel];
    ipcMain.handle(channel, async (event, payload) => {
      // Every fault below is (1) logged locally through the redacting logger and
      // (2) rejected with a TYPED, REDACTED envelope — a stable `code` + the error
      // class `name`, NEVER the raw message/stack (#373, #440). Re-throwing the raw
      // error would serialize its message/stack across `ipcRenderer.invoke` into the
      // untrusted renderer, leaking ids/paths/item text; the envelope closes that.
      // Semgrep's unsafe-formatstring (CWE-134) matches below are false positives: a
      // JS template literal is not a printf format string, and `channel` is an
      // internal IPC channel name, never user/attacker input (#406).
      const senderUrl = event.senderFrame?.url ?? '';
      if (!isTrustedSenderUrl(senderUrl, options)) {
        log.error(`[kawsay] IPC on "${channel}" rejected: untrusted sender`); // nosemgrep: unsafe-formatstring
        throw makeIpcError(
          new Error('untrusted sender'),
          IPC_ERROR_CODES.UNTRUSTED_SENDER,
        );
      }

      let request: z.output<typeof requestSchema>;
      try {
        request = requestSchema.parse(payload);
      } catch (error) {
        log.warn(`[kawsay] IPC request for "${channel}" failed validation`, error); // nosemgrep: unsafe-formatstring
        throw makeIpcError(error, IPC_ERROR_CODES.BAD_REQUEST);
      }

      let response: IpcResponse<typeof channel>;
      try {
        response = await handler(request as never);
      } catch (error) {
        log.error(`[kawsay] IPC handler for "${channel}" failed`, error); // nosemgrep: unsafe-formatstring
        throw makeIpcError(error, IPC_ERROR_CODES.HANDLER_FAULT);
      }

      try {
        return responseSchema.parse(response);
      } catch (error) {
        log.error(`[kawsay] IPC response for "${channel}" failed validation`, error); // nosemgrep: unsafe-formatstring
        throw makeIpcError(error, IPC_ERROR_CODES.BAD_RESPONSE);
      }
    });
  }
}

function ipcChannels(): IpcChannel[] {
  return Object.keys(ipcContract) as IpcChannel[];
}
