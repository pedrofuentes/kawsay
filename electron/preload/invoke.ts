import {
  ipcContract,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
} from '@shared/ipc/contract';

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
      throw new Error(`Unknown IPC channel: ${String(channel)}`);
    }
    const request = schema.request.parse(payload);
    const reply = await rawInvoke(channel, request);
    return schema.response.parse(reply) as IpcResponse<C>;
  };
}

type IpcContractEntry = (typeof ipcContract)[IpcChannel];
