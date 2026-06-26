// Drives the opt-in transcription-model download (AC-22 / ADR-0027 Decision 6).
// Mirrors useImport: it subscribes once to the typed progress stream and tears the
// subscription down on unmount, and it is CALLER-INITIATED — nothing here runs
// until enable() is called, so no model byte moves without an explicit opt-in. On
// mount it only *reads* whether a verified model is already present (the capability
// gate), never starting a download. Raw failure messages from the stream are
// dropped; only a typed { kind, retryable } is kept for the UI to translate kindly.
import { useCallback, useEffect, useReducer } from 'react';
import type { ModelDownloadProgressEvent } from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';

export type ModelDownloadStatus = 'checking' | 'idle' | 'downloading' | 'ready' | 'error';

export type ModelDownloadPhase = ModelDownloadProgressEvent['phase'];

/** The typed failure category the UI branches on (network/disk/integrity/http). */
export type ModelDownloadErrorKind = NonNullable<ModelDownloadProgressEvent['error']>['kind'];

export interface ModelDownloadError {
  /** `null` when the failure came from a missing bridge or a rejected call. */
  kind: ModelDownloadErrorKind | null;
  retryable: boolean;
}

export interface ModelDownloadState {
  status: ModelDownloadStatus;
  phase: ModelDownloadPhase | null;
  bytesDownloaded: number;
  totalBytes: number;
  error: ModelDownloadError | null;
}

export interface UseModelDownloadResult extends ModelDownloadState {
  /** True once the model is present AND verified — the transcription gate. */
  ready: boolean;
  /** The explicit opt-in: start the one-time download (idempotent per click). */
  enable: () => Promise<void>;
  /** Clear the error and try the download again. */
  retry: () => Promise<void>;
}

const INITIAL_STATE: ModelDownloadState = {
  status: 'checking',
  phase: null,
  bytesDownloaded: 0,
  totalBytes: 0,
  error: null,
};

const GENERIC_ERROR: ModelDownloadError = { kind: null, retryable: true };

type Action =
  | { type: 'checked'; ready: boolean }
  | { type: 'enabling' }
  | { type: 'already-present' }
  | { type: 'progress'; event: ModelDownloadProgressEvent }
  | { type: 'failed'; error: ModelDownloadError };

function reducer(state: ModelDownloadState, action: Action): ModelDownloadState {
  switch (action.type) {
    case 'checked':
      // A user opt-in may have already moved us on; never clobber that.
      if (state.status !== 'checking') {
        return state;
      }
      return { ...INITIAL_STATE, status: action.ready ? 'ready' : 'idle' };
    case 'enabling':
      return { ...INITIAL_STATE, status: 'downloading' };
    case 'already-present':
      return { ...state, status: 'ready', phase: 'already-present', error: null };
    case 'progress': {
      const { event } = action;
      const next: ModelDownloadState = {
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

export function useModelDownload(): UseModelDownloadResult {
  const api = useKawsayApi();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  useEffect(() => {
    if (api === undefined) {
      return undefined;
    }
    const unsubscribe = api.onModelDownloadProgress((event) => {
      dispatch({ type: 'progress', event });
    });
    return unsubscribe;
  }, [api]);

  // Read the gate once on mount — present + verified or not. This NEVER downloads.
  useEffect(() => {
    if (api === undefined) {
      dispatch({ type: 'checked', ready: false });
      return undefined;
    }
    let active = true;
    void api
      .isTranscriptionModelReady()
      .then((ready) => {
        if (active) {
          dispatch({ type: 'checked', ready });
        }
      })
      .catch(() => {
        // Intentional silent fallback: a failed readiness probe is treated as
        // "not ready" rather than surfaced as an alarming error. There is no renderer
        // logger to route a diagnostic to, and it self-heals — the next enable() runs
        // the real download + verification regardless of this probe (covered by
        // use-model-download.test.tsx "self-heals after a readiness-check rejection").
        if (active) {
          dispatch({ type: 'checked', ready: false });
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
      const { status } = await api.downloadTranscriptionModel();
      if (status === 'already-present') {
        dispatch({ type: 'already-present' });
      }
      // 'started' ⇒ the download is in flight; the progress stream drives the rest.
    } catch {
      dispatch({ type: 'failed', error: GENERIC_ERROR });
    }
  }, [api]);

  const retry = useCallback((): Promise<void> => enable(), [enable]);

  return { ...state, ready: state.status === 'ready', enable, retry };
}
