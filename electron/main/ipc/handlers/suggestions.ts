import {
  SUGGESTIONS_ACCEPT,
  SUGGESTIONS_DISMISS,
  SUGGESTIONS_LIST,
  SUGGESTIONS_MERGE,
  ipcContract,
  type IpcRequest,
  type IpcResponse,
} from '@shared/ipc/contract';
import type { SuggestionsLibraryPort } from '../../categorize/suggestions-library';

// The SUGGESTED-COLLECTIONS review-tray IPC handlers (T-M4-3c / #273). Each is a
// pure function of an injected, lazily-resolved library port, so they unit-test
// without an Electron runtime (the real port is wired in electron/main/index.ts).
// Every response is re-parsed through the contract schema before it crosses the
// bridge, so a handler can never emit a payload the renderer's validator would
// reject (defence in depth, AC-4). Listing is READ-ONLY derivation; a collections
// row is created ONLY by an explicit accept/merge here (AC-32).

/**
 * The per-library suggestions capability the tray handlers drive — the full {@link
 * SuggestionsLibraryPort} surface (list + the three curation actions). Kept
 * structural so the handlers stay Electron-free and unit-testable with a fake.
 */
export type SuggestionsLibraryProvider = Pick<
  SuggestionsLibraryPort,
  'list' | 'accept' | 'merge' | 'dismiss'
>;

/**
 * Deps for the tray handlers: a lazy accessor for the OPEN library's port, so a
 * call with no library open rejects (the accessor throws) rather than acting on a
 * stale handle — mirrors the categorization handlers.
 */
export interface SuggestionsLibraryDeps {
  readonly getLibrary: () => SuggestionsLibraryProvider;
}

/**
 * `suggestions:list` — project the pending suggestions (each with a few example
 * items) plus the real collections a merge may target. Pure derivation: it creates
 * NO collections row, so the main list stays byte-identical until the user acts.
 */
export async function handleSuggestionsList(
  deps: SuggestionsLibraryDeps,
): Promise<IpcResponse<typeof SUGGESTIONS_LIST>> {
  return ipcContract[SUGGESTIONS_LIST].response.parse(deps.getLibrary().list());
}

/**
 * `suggestions:accept` — materialise a suggestion into a real collection (optionally
 * renamed first) and return the refreshed tray; the accepted suggestion drops out.
 * Idempotent per category, so a double-accept never creates a second collection.
 */
export async function handleSuggestionsAccept(
  deps: SuggestionsLibraryDeps,
  request: IpcRequest<typeof SUGGESTIONS_ACCEPT>,
): Promise<IpcResponse<typeof SUGGESTIONS_ACCEPT>> {
  return ipcContract[SUGGESTIONS_ACCEPT].response.parse(deps.getLibrary().accept(request));
}

/**
 * `suggestions:merge` — fold a suggestion into an existing collection (members move
 * over, the source category is tombstoned so it is not re-proposed) and return the
 * refreshed tray.
 */
export async function handleSuggestionsMerge(
  deps: SuggestionsLibraryDeps,
  request: IpcRequest<typeof SUGGESTIONS_MERGE>,
): Promise<IpcResponse<typeof SUGGESTIONS_MERGE>> {
  return ipcContract[SUGGESTIONS_MERGE].response.parse(deps.getLibrary().merge(request));
}

/**
 * `suggestions:dismiss` — durably tombstone a suggestion so the derivation never
 * re-proposes it (AC-32) and return the refreshed tray. Idempotent per category.
 */
export async function handleSuggestionsDismiss(
  deps: SuggestionsLibraryDeps,
  request: IpcRequest<typeof SUGGESTIONS_DISMISS>,
): Promise<IpcResponse<typeof SUGGESTIONS_DISMISS>> {
  return ipcContract[SUGGESTIONS_DISMISS].response.parse(deps.getLibrary().dismiss(request));
}
