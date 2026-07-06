import type { z } from 'zod';
import { ipcContract, type IpcChannel, type IpcResponse } from '@shared/ipc/contract';
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
      const senderUrl = event.senderFrame?.url ?? '';
      if (!isTrustedSenderUrl(senderUrl, options)) {
        throw new Error(
          `Rejected IPC on "${channel}" from untrusted sender: ${senderUrl || '<none>'}`,
        );
      }
      const request = requestSchema.parse(payload);
      try {
        const response = await handler(request as never);
        return responseSchema.parse(response);
      } catch (error) {
        // Log-on-error shim (#373): a main-process handler / response-shape fault
        // otherwise leaves NO local trace, so field debugging would rely on renderer
        // traces only. Emit ONE local diagnostic naming the channel, then re-throw so
        // the trust-boundary contract is unchanged (the error still reaches the
        // renderer). Local console only — no telemetry; the raw error is projected to
        // name/code (never message/stack), so a fault can't leak ids/paths/item text.
        console.error(`[kawsay] IPC handler for "${channel}" failed`, diagnosticError(error));
        throw error;
      }
    });
  }
}

function ipcChannels(): IpcChannel[] {
  return Object.keys(ipcContract) as IpcChannel[];
}

/**
 * A privacy-preserving projection of an error for a LOCAL diagnostic line (no
 * telemetry, no egress): only the error `name` and an optional errno `code` — never
 * the raw `message`/`stack`, which can carry an id, a file path, or item text.
 * Mirrors the orchestrators' helper so main-process faults log the same shape.
 */
function diagnosticError(error: unknown): { code?: string; name: string } {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? { name: error.name } : { name: error.name, code };
  }
  return { name: typeof error };
}
