// Preload-side guard for one-way main → renderer events. It re-validates every
// incoming payload against the event contract and DROPS any that fails, so a
// malformed event can never reach React even if it somehow left the main
// process. The raw transport (`ipcRenderer.on` + remove) is injected so this
// stays pure and unit-testable without an Electron runtime.

import {
  ipcEventContract,
  type IpcEventChannel,
  type IpcEventPayload,
} from '@shared/ipc/events';

/** The underlying event transport: register a channel listener, get an
 *  unsubscribe back. */
export type RawSubscribe = (
  channel: string,
  listener: (payload: unknown) => void,
) => () => void;

/**
 * Build the single `subscribe` helper the preload bridge exposes. The renderer
 * only ever receives payloads that pass the contract schema; invalid ones are
 * silently dropped (defence-in-depth behind the main-side sender).
 */
export function createValidatedSubscribe(rawSubscribe: RawSubscribe) {
  return function subscribe<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventPayload<C>) => void,
  ): () => void {
    const schema = ipcEventContract[channel];
    return rawSubscribe(channel, (payload) => {
      const result = schema.safeParse(payload);
      if (result.success) {
        listener(result.data as IpcEventPayload<C>);
      }
    });
  };
}
