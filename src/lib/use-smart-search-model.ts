// Drives the opt-in SMART-SEARCH embedder-model download (M4-1b / ADR-0029).
// Mirrors useModelDownload (transcription): it subscribes once to the typed
// SMART-SEARCH progress stream — a channel SEPARATE from transcription's, so the
// two downloads never cross-talk — and tears the subscription down on unmount, and
// it is CALLER-INITIATED: nothing here runs until enable() is called, so no model
// byte moves without an explicit opt-in. On mount it only *reads* the capability
// snapshot (whether the feature is `offered`, the user `optedIn`, and the model is
// present-and-verified), never starting a download. Raw failure messages from the
// stream are dropped; only a typed { kind, retryable } is kept for the UI to
// translate kindly. Kept fully independent of the transcription hook (its own
// state, types, and copy) so enabling one never implies the other.
import { useCallback, useEffect, useReducer } from 'react';
import type { ModelDownloadProgressEvent } from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';

export type SmartSearchModelStatus =
  | 'checking'
  | 'idle'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'unsupported';

export type SmartSearchModelPhase = ModelDownloadProgressEvent['phase'];

/** The typed failure category the UI branches on (network/disk/integrity/http). */
export type SmartSearchModelErrorKind = NonNullable<ModelDownloadProgressEvent['error']>['kind'];

export interface SmartSearchModelError {
  /** `null` when the failure came from a missing bridge or a rejected call. */
  kind: SmartSearchModelErrorKind | null;
  retryable: boolean;
}

/** The capability snapshot the mount-time probe resolves. */
export interface SmartSearchStatus {
  optedIn: boolean;
  modelReady: boolean;
  offered: boolean;
}

export interface SmartSearchModelState {
  status: SmartSearchModelStatus;
  phase: SmartSearchModelPhase | null;
  bytesDownloaded: number;
  totalBytes: number;
  error: SmartSearchModelError | null;
  /** Whether the user has already opted in (from the capability snapshot). */
  optedIn: boolean;
  /**
   * Whether smart search is even offered yet — true ONLY once a real embedder
   * model is published AND this platform can install it. The consent card stays
   * hidden entirely while this is false (pre-publish).
   */
  offered: boolean;
}

export interface UseSmartSearchModelResult extends SmartSearchModelState {
  /** True once the embedder model is present AND verified — the smart-search gate. */
  modelReady: boolean;
  /** The explicit opt-in: start the one-time download (idempotent per click). */
  enable: () => Promise<void>;
  /** Clear the error and try the download again. */
  retry: () => Promise<void>;
}

const INITIAL_STATE: SmartSearchModelState = {
  status: 'checking',
  phase: null,
  bytesDownloaded: 0,
  totalBytes: 0,
  error: null,
  optedIn: false,
  offered: false,
};

const GENERIC_ERROR: SmartSearchModelError = { kind: null, retryable: true };

type Action =
  | { type: 'checked'; status: SmartSearchStatus }
  | { type: 'enabling' }
  | { type: 'already-present' }
  | { type: 'unsupported' }
  | { type: 'progress'; event: ModelDownloadProgressEvent }
  | { type: 'failed'; error: SmartSearchModelError };

function reducer(state: SmartSearchModelState, action: Action): SmartSearchModelState {
  switch (action.type) {
    case 'checked': {
      const { optedIn, offered, modelReady } = action.status;
      // A user opt-in may have already moved us on; never clobber that status, but
      // still record the capability flags (offered/optedIn) the probe just resolved.
      if (state.status !== 'checking') {
        return { ...state, optedIn, offered };
      }
      return { ...INITIAL_STATE, status: modelReady ? 'ready' : 'idle', optedIn, offered };
    }
    case 'enabling':
      // Reset the download sub-state, but keep the capability flags so the card
      // never flickers hidden (offered) mid-download.
      return {
        ...INITIAL_STATE,
        status: 'downloading',
        optedIn: state.optedIn,
        offered: state.offered,
      };
    case 'already-present':
      return { ...state, status: 'ready', phase: 'already-present', error: null };
    case 'unsupported':
      // A terminal, calm, NON-retryable state: this platform has nowhere to install
      // the model, so a retry would deterministically fail. Search stays exact FTS.
      return { ...state, status: 'unsupported', error: null };
    case 'progress': {
      const { event } = action;
      const next: SmartSearchModelState = {
        ...state,
        phase: event.phase,
        bytesDownloaded: event.bytesDownloaded,
        totalBytes: event.totalBytes,
      };
      if (event.phase === 'error') {
        return {
          ...next,
          status: 'error',
          error: event.error
            ? { kind: event.error.kind, retryable: event.error.retryable }
            : GENERIC_ERROR,
        };
      }
      if (event.phase === 'done' || event.phase === 'already-present') {
        return { ...next, status: 'ready', error: null };
      }
      return { ...next, status: 'downloading', error: null };
    }
    case 'failed':
      return { ...state, status: 'error', error: action.error };
    default:
      return state;
  }
}

export function useSmartSearchModel(): UseSmartSearchModelResult {
  const api = useKawsayApi();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  useEffect(() => {
    if (api === undefined) {
      return undefined;
    }
    const unsubscribe = api.onSmartSearchModelDownloadProgress((event) => {
      dispatch({ type: 'progress', event });
    });
    return unsubscribe;
  }, [api]);

  // Read the capability snapshot once on mount — offered/optedIn/present. This
  // NEVER downloads.
  useEffect(() => {
    if (api === undefined) {
      dispatch({ type: 'checked', status: { optedIn: false, modelReady: false, offered: false } });
      return undefined;
    }
    let active = true;
    void api
      .getSmartSearchStatus()
      .then((status) => {
        if (active) {
          dispatch({ type: 'checked', status });
        }
      })
      .catch(() => {
        // Intentional silent fallback: a failed capability probe is treated as
        // "not offered / not ready" rather than surfaced as an alarming error (there
        // is no renderer logger to route a diagnostic to). It self-heals — a later
        // enable() runs the real download + verification regardless of this probe
        // (covered by use-smart-search-model.test.tsx "self-heals after a
        // status-probe rejection"). Defaulting offered=false keeps the card hidden
        // rather than revealing an unusable surface.
        if (active) {
          dispatch({
            type: 'checked',
            status: { optedIn: false, modelReady: false, offered: false },
          });
        }
      });
    return () => {
      active = false;
    };
  }, [api]);

  const enable = useCallback(async (): Promise<void> => {
    if (api === undefined) {
      dispatch({ type: 'failed', error: GENERIC_ERROR });
      return;
    }
    dispatch({ type: 'enabling' });
    try {
      const { outcome } = await api.enableSmartSearch();
      if (outcome === 'already-present') {
        dispatch({ type: 'already-present' });
      } else if (outcome === 'unsupported-platform') {
        dispatch({ type: 'unsupported' });
      }
      // 'download-started' ⇒ the download is in flight; the progress stream drives
      // the rest.
    } catch {
      dispatch({ type: 'failed', error: GENERIC_ERROR });
    }
  }, [api]);

  const retry = useCallback((): Promise<void> => enable(), [enable]);

  return { ...state, modelReady: state.status === 'ready', enable, retry };
}
