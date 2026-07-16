import {
  SETTINGS_GET,
  SETTINGS_SET,
  ipcContract,
  type IpcRequest,
  type IpcResponse,
} from '@shared/ipc/contract';
import type { SettingsDTO } from '@shared/ipc/schemas';

// The app-wide UX SETTINGS IPC handlers (AC-13 / Journey G, #433). Each is a
// pure function of its injected store port (the real one is the main-side
// `SettingsStore`), so they unit-test without an Electron runtime (mirrors
// `categorize.ts`'s status/consent handlers). Every response is re-parsed
// through the contract schema before it crosses the bridge, so a handler can
// never emit a payload the renderer's validator would reject (defence in
// depth, AC-4).

/**
 * The durable settings seam the handlers read + write, narrowed to the two
 * methods they need (the real port is the main-side {@link
 * import('../../settings/settings-store').SettingsStore}). Kept structural so
 * the handlers stay Electron-free and unit-testable.
 */
export interface SettingsStorePort {
  /** Read the current durable snapshot (defaults for absent/corrupt config). */
  get(): SettingsDTO;
  /** Merge `patch` onto the durable snapshot, persist it, and return the RESOLVED snapshot. */
  set(patch: Partial<SettingsDTO>): SettingsDTO;
}

export interface SettingsDeps {
  readonly settings: SettingsStorePort;
}

/**
 * `settings:get` — report the persisted settings snapshot (text size +
 * reduced-motion override) the Settings view reads on mount, and the app root
 * applies immediately (src/lib/settings.tsx).
 */
export async function handleSettingsGet(
  deps: SettingsDeps,
): Promise<IpcResponse<typeof SETTINGS_GET>> {
  return ipcContract[SETTINGS_GET].response.parse(deps.settings.get());
}

/**
 * `settings:set` — persist a PARTIAL update (CALLER-INITIATED from a control)
 * and echo the resolved FULL settings re-read from the store, so the UI always
 * reflects the durable truth rather than an optimistic guess.
 */
export async function handleSettingsSet(
  deps: SettingsDeps,
  request: IpcRequest<typeof SETTINGS_SET>,
): Promise<IpcResponse<typeof SETTINGS_SET>> {
  return ipcContract[SETTINGS_SET].response.parse(deps.settings.set(request));
}
