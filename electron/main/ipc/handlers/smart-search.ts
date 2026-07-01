import {
  SMART_SEARCH_DOWNLOAD_MODEL,
  SMART_SEARCH_MODEL_STATUS,
  ipcContract,
  type IpcResponse,
} from '@shared/ipc/contract';

/**
 * The smart-search enable/status capability the handlers drive, narrowed to a
 * structural subset of the main-process SmartSearchController (search/
 * smart-search-model.ts) so the handlers stay pure and unit-testable without an
 * Electron runtime (the real controller is wired in electron/main/index.ts).
 * `enable` is fire-and-forget in the controller — a started download's progress and
 * terminal result reach the renderer over the `smartSearch:modelDownloadProgress`
 * event, NOT this response.
 */
export interface SmartSearchModelController {
  /** The current { optedIn, modelReady } snapshot (offered is layered on by the handler). */
  status(): Promise<{ optedIn: boolean; modelReady: boolean }>;
  /** Explicit opt-in: persist consent, then (if needed + supported) fetch+verify the model. */
  enable(): Promise<{ outcome: 'download-started' | 'already-present' | 'unsupported-platform' }>;
}

export interface SmartSearchStatusDeps {
  readonly controller: SmartSearchModelController;
  /**
   * Whether the feature is even offered yet — true ONLY when a real model is
   * published AND this platform can install it. Layered on here (not carried by the
   * controller) because it is a build/packaging fact, not a per-user state.
   */
  readonly isOffered: () => boolean;
}

export interface SmartSearchEnableDeps {
  readonly controller: SmartSearchModelController;
}

/**
 * `smartSearch:modelStatus` handler logic (M4-1b): report the capability snapshot the
 * opt-in UI reads — the user's `optedIn` choice and whether the model is
 * present-and-verified (`modelReady`) from the controller, plus whether the feature
 * is `offered` at all from {@link SmartSearchStatusDeps.isOffered}.
 */
export async function handleSmartSearchStatus(
  deps: SmartSearchStatusDeps,
): Promise<IpcResponse<typeof SMART_SEARCH_MODEL_STATUS>> {
  const { optedIn, modelReady } = await deps.controller.status();
  return ipcContract[SMART_SEARCH_MODEL_STATUS].response.parse({
    optedIn,
    modelReady,
    offered: deps.isOffered(),
  });
}

/**
 * `smartSearch:downloadModel` handler logic (M4-1b). Caller-initiated: this runs ONLY
 * when the renderer explicitly invokes the channel (the opt-in UI is a later slice) —
 * it is never auto-triggered. It defers entirely to the controller, which records the
 * durable opt-in, then (when needed + supported) kicks off the download fire-and-forget
 * and reports the terminal `outcome`. Progress and any failure reach the renderer via
 * the `smartSearch:modelDownloadProgress` event, not this response (the controller
 * already swallows a rejected download).
 */
export async function handleSmartSearchEnable(
  deps: SmartSearchEnableDeps,
): Promise<IpcResponse<typeof SMART_SEARCH_DOWNLOAD_MODEL>> {
  return ipcContract[SMART_SEARCH_DOWNLOAD_MODEL].response.parse({
    outcome: (await deps.controller.enable()).outcome,
  });
}
