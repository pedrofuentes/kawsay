import { APP_GET_VERSION, ipcContract, type IpcResponse } from '@shared/ipc/contract';

/**
 * The app capabilities the handler needs, injected so the handler stays pure
 * and Electron-free (`app.getVersion` in production, a stub in tests).
 */
export interface AppHandlerDeps {
  readonly getVersion: () => string;
}

/**
 * `app:getVersion` handler logic: report the running application version,
 * shaped and validated against the contract's response schema. The schema's
 * `min(1)` makes an empty version a hard error rather than a silent blank.
 */
export function handleGetVersion(deps: AppHandlerDeps): IpcResponse<typeof APP_GET_VERSION> {
  return ipcContract[APP_GET_VERSION].response.parse({ version: deps.getVersion() });
}
