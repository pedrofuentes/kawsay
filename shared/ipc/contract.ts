import { z } from 'zod';

/** IPC channel: request the running application version. */
export const APP_GET_VERSION = 'app:getVersion';

/**
 * The complete IPC contract. Every channel declares a zod schema for its
 * request and its response. The preload bridge validates before sending and
 * the main-process handler re-validates on receipt, so a malformed payload can
 * never cross the trust boundary in either direction (ARCHITECTURE §2.3, §2.6).
 *
 * Schemas are intentionally `strictObject` — unknown keys are rejected, not
 * silently stripped.
 */
export const ipcContract = {
  [APP_GET_VERSION]: {
    request: z.strictObject({}),
    response: z.strictObject({ version: z.string().min(1) }),
  },
} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract & string;
export type IpcRequest<C extends IpcChannel> = z.input<IpcContract[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.output<IpcContract[C]['response']>;
