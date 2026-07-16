import {
  ipcContract,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
} from '@shared/ipc/contract';
import { IPC_ERROR_CODES, IpcError, ipcErrorFrom } from '@shared/ipc/error-envelope';

/**
 * The underlying transport (`ipcRenderer.invoke`), injected so the validated
 * wrapper stays pure and unit-testable without an Electron runtime.
 */
export type RawInvoke = (channel: string, payload: unknown) => Promise<unknown>;

/**
 * Build the single `invoke` helper the preload bridge uses for every channel.
 * It validates the request against the contract BEFORE it crosses the process
 * boundary and validates main's reply AFTER it returns — so neither a buggy
 * renderer nor a misbehaving main can push an unexpected shape across the trust
 * boundary (ARCHITECTURE §2.3, §2.6).
 */
export function createValidatedInvoke(rawInvoke: RawInvoke) {
  return async function invoke<C extends IpcChannel>(
    channel: C,
    payload: IpcRequest<C>,
  ): Promise<IpcResponse<C>> {
    const schema = ipcContract[channel] as IpcContractEntry | undefined;
    if (schema === undefined) {
      throw new IpcError(IPC_ERROR_CODES.BAD_REQUEST, 'UnknownChannelError');
    }

    let request: unknown;
    try {
      request = schema.request.parse(payload);
    } catch {
      // A buggy/compromised renderer sent an unexpected shape — refuse it BEFORE it
      // crosses, as a typed error the renderer can handle (no raw zod text surfaced).
      throw new IpcError(IPC_ERROR_CODES.BAD_REQUEST, 'ZodError');
    }

    let reply: unknown;
    try {
      reply = await rawInvoke(channel, request);
    } catch (cause) {
      // Main rejects a fault with a REDACTED error whose tagged message encodes only
      // {code, name} — never the raw message/stack (#440). Recover the typed IpcError
      // (switch on `code` for copy); an untagged rejection is still surfaced redacted.
      throw ipcErrorFrom(cause, IPC_ERROR_CODES.HANDLER_FAULT);
    }

    try {
      return schema.response.parse(reply) as IpcResponse<C>;
    } catch {
      // Main answered with a shape the contract forbids — defend the renderer from a
      // misbehaving main, again as a typed error (never the raw reply/zod detail).
      throw new IpcError(IPC_ERROR_CODES.BAD_RESPONSE, 'ZodError');
    }
  };
}

type IpcContractEntry = (typeof ipcContract)[IpcChannel];
