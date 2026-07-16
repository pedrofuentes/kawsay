import {
  APP_CAPABILITIES,
  APP_GET_VERSION,
  ipcContract,
  type IpcResponse,
} from '@shared/ipc/contract';
import type { CapabilitiesReport } from '../../app/capabilities';

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

/**
 * The capability probe the handler needs, injected so the handler stays pure and
 * Electron-free (the composition root supplies the real per-seam probes).
 */
export interface CapabilitiesHandlerDeps {
  readonly getCapabilities: () => CapabilitiesReport;
}

/**
 * `app:capabilities` handler logic (#441): report the aggregate capability snapshot,
 * shaped and validated against the contract's strict response schema so a malformed
 * report is a hard error rather than a silently wrong DTO crossing the boundary.
 */
export function handleCapabilities(
  deps: CapabilitiesHandlerDeps,
): IpcResponse<typeof APP_CAPABILITIES> {
  return ipcContract[APP_CAPABILITIES].response.parse(deps.getCapabilities());
}
