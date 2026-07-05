import {
  CATEGORIZE_APPLY_CORRECTION,
  CATEGORIZE_CANCEL,
  CATEGORIZE_LIST_FOR_ITEM,
  CATEGORIZE_SET_CONSENT,
  CATEGORIZE_START,
  CATEGORIZE_STATUS,
  ipcContract,
  type IpcRequest,
  type IpcResponse,
} from '@shared/ipc/contract';
import type { CategorizationLibraryPort } from '../../categorize/categorization-library';

// The opt-in EXPLAINABLE CATEGORIZATION IPC handlers (T-M4-2h / #270). Each is a
// pure function of its injected collaborators — the durable consent port and the
// per-library categorization port — so they unit-test without an Electron runtime
// (the real ports are wired in electron/main/index.ts). Every response is re-parsed
// through the contract schema before it crosses the bridge, so a handler can never
// emit a payload the renderer's validator would reject (defence in depth, AC-4).

/**
 * The durable opt-in seam the status/consent handlers read + write, narrowed to the
 * two methods they need (the real store is the M2 {@link ConsentStore}). Kept
 * structural so the handlers stay Electron-free and unit-testable.
 */
export interface CategorizationConsentPort {
  /** Whether the user has explicitly opted in (false for absent/corrupt config). */
  isOptedIn(): boolean;
  /** Persist the opt-in choice durably. */
  setOptedIn(value: boolean): void;
}

/**
 * The per-library categorization capability the read/correction/run handlers drive,
 * narrowed to a structural subset of {@link CategorizationLibraryPort} (its `status`
 * snapshot is streamed via the progress event, not requested here).
 */
export type CategorizationLibraryProvider = Pick<
  CategorizationLibraryPort,
  'listForItem' | 'applyCorrection' | 'start' | 'cancel'
>;

/** Deps for the status handler: the consent port + the build-time offered gate. */
export interface CategorizationStatusDeps {
  readonly consent: CategorizationConsentPort;
  /**
   * Whether the feature is even offered yet — true ONLY when the gazetteer asset is
   * bundled. Layered on here (not carried by the consent port) because it is a
   * build/packaging fact, not a per-user state.
   */
  readonly isOffered: () => boolean;
}

/** Deps for the consent-setter handler. */
export interface CategorizationSetConsentDeps {
  readonly consent: CategorizationConsentPort;
}

/**
 * Deps for the per-library handlers: a lazy accessor for the OPEN library's port, so
 * a call with no library open rejects (the accessor throws) rather than acting on a
 * stale handle.
 */
export interface CategorizationLibraryDeps {
  readonly getLibrary: () => CategorizationLibraryProvider;
}

/**
 * `categorize:status` — report the opt-in gate snapshot the UI reads: the user's
 * durable `optedIn` choice layered with whether the feature is `offered` at all
 * (the bundled-asset gate). While `offered` is false the whole opt-in surface stays
 * hidden; while `optedIn` is false NO chips render (default-off, AC-33).
 */
export async function handleCategorizationStatus(
  deps: CategorizationStatusDeps,
): Promise<IpcResponse<typeof CATEGORIZE_STATUS>> {
  return ipcContract[CATEGORIZE_STATUS].response.parse({
    optedIn: deps.consent.isOptedIn(),
    offered: deps.isOffered(),
  });
}

/**
 * `categorize:setConsent` — persist the opt-in choice (CALLER-INITIATED from the
 * consent toggle) and echo the resolved state re-read from the store, so the UI
 * reflects the durable truth. Turning it off stops all future chip rendering; the
 * user's existing corrections stay on disk (AC-30).
 */
export async function handleCategorizationSetConsent(
  deps: CategorizationSetConsentDeps,
  request: IpcRequest<typeof CATEGORIZE_SET_CONSENT>,
): Promise<IpcResponse<typeof CATEGORIZE_SET_CONSENT>> {
  deps.consent.setOptedIn(request.optedIn);
  return ipcContract[CATEGORIZE_SET_CONSENT].response.parse({ optedIn: deps.consent.isOptedIn() });
}

/**
 * `categorize:listForItem` — resolve ONE item's explainable chips by its opaque
 * catalog id. The renderer passes only the id (never a path); the resolved chips
 * carry no path or vector (AC-4).
 */
export async function handleCategorizationListForItem(
  deps: CategorizationLibraryDeps,
  request: IpcRequest<typeof CATEGORIZE_LIST_FOR_ITEM>,
): Promise<IpcResponse<typeof CATEGORIZE_LIST_FOR_ITEM>> {
  const chips = deps.getLibrary().listForItem(request.itemId);
  return ipcContract[CATEGORIZE_LIST_FOR_ITEM].response.parse(chips);
}

/**
 * `categorize:applyCorrection` — forward a user correction (confirm/remove/reassign/
 * rename) to the library port and return the item's refreshed chips. The correction
 * is persisted as a durable `user` decision a later re-cluster can never clobber.
 */
export async function handleCategorizationApplyCorrection(
  deps: CategorizationLibraryDeps,
  request: IpcRequest<typeof CATEGORIZE_APPLY_CORRECTION>,
): Promise<IpcResponse<typeof CATEGORIZE_APPLY_CORRECTION>> {
  const chips = deps.getLibrary().applyCorrection(request);
  return ipcContract[CATEGORIZE_APPLY_CORRECTION].response.parse(chips);
}

/**
 * `categorize:start` — start the gated categorization run and pass its result
 * through. A refusal (opted-out / no signal) is a TYPED outcome, not a throw, so the
 * UI can branch calmly. Per-item progress streams over the `categorize:progress`
 * event, not this response.
 */
export async function handleCategorizationStart(
  deps: CategorizationLibraryDeps,
): Promise<IpcResponse<typeof CATEGORIZE_START>> {
  const result = await deps.getLibrary().start();
  return ipcContract[CATEGORIZE_START].response.parse(result);
}

/**
 * `categorize:cancel` — cooperatively cancel the in-flight run; report whether one
 * was stopped. Whatever already settled stays persisted.
 */
export async function handleCategorizationCancel(
  deps: CategorizationLibraryDeps,
): Promise<IpcResponse<typeof CATEGORIZE_CANCEL>> {
  return ipcContract[CATEGORIZE_CANCEL].response.parse(deps.getLibrary().cancel());
}
