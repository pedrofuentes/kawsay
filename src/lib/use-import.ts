// Drives a single import job: starts it through the typed bridge, tracks the
// live progress stream (filtered to this job), and lands on a terminal state
// (complete / cancelled / error). The subscription is set up once and torn down
// on unmount so we never leak listeners. Raw error codes are stored for the UI
// to translate — they are never meant to be shown verbatim.
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ImportProgressEvent, ImportSummaryDTO, SourceType } from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';

export type ImportStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'cancelling'
  | 'complete'
  | 'cancelled'
  | 'error';

export type ImportPhase = ImportProgressEvent['phase'];

export interface StartImportInput {
  sourceType: SourceType;
  inputPath: string;
}

export interface ImportState {
  status: ImportStatus;
  jobId: string | null;
  processed: number;
  total: number | null;
  message: string | null;
  phase: ImportPhase | null;
  summary: ImportSummaryDTO | null;
  error: string | null;
}

export interface UseImportResult extends ImportState {
  start: (input: StartImportInput) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

const INITIAL_STATE: ImportState = {
  status: 'idle',
  jobId: null,
  processed: 0,
  total: null,
  message: null,
  phase: null,
  summary: null,
  error: null,
};

type Action =
  | { type: 'start' }
  | { type: 'started'; jobId: string }
  | { type: 'progress'; event: ImportProgressEvent }
  | { type: 'cancelling' }
  | { type: 'failed'; error: string }
  | { type: 'reset' };

function reducer(state: ImportState, action: Action): ImportState {
  switch (action.type) {
    case 'start':
      return { ...INITIAL_STATE, status: 'starting' };
    case 'started':
      return { ...state, status: 'running', jobId: action.jobId };
    case 'cancelling':
      return state.status === 'running' || state.status === 'starting'
        ? { ...state, status: 'cancelling' }
        : state;
    case 'progress': {
      const { event } = action;
      const next: ImportState = {
        ...state,
        processed: event.processed,
        total: event.total,
        message: event.message ?? state.message,
        phase: event.phase,
      };
      if (event.phase !== 'done') {
        return { ...next, status: 'running' };
      }
      if (event.error !== null) {
        return { ...next, status: 'error', error: event.error };
      }
      if (event.summary !== null) {
        return {
          ...next,
          status: event.summary.cancelled ? 'cancelled' : 'complete',
          summary: event.summary,
        };
      }
      return { ...next, status: 'complete' };
    }
    case 'failed':
      return { ...state, status: 'error', error: action.error };
    case 'reset':
      return INITIAL_STATE;
    default:
      return state;
  }
}

export function useImport(): UseImportResult {
  const api = useKawsayApi();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const jobIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (api === undefined) {
      return undefined;
    }
    const unsubscribe = api.onImportProgress((event) => {
      if (jobIdRef.current === null || event.jobId !== jobIdRef.current) {
        return;
      }
      dispatch({ type: 'progress', event });
    });
    return unsubscribe;
  }, [api]);

  const start = useCallback(
    async (input: StartImportInput): Promise<void> => {
      if (api === undefined) {
        dispatch({ type: 'failed', error: 'Kawsay is not connected on this device.' });
        return;
      }
      dispatch({ type: 'start' });
      try {
        const { jobId } = await api.startImport(input);
        jobIdRef.current = jobId;
        dispatch({ type: 'started', jobId });
      } catch (cause) {
        dispatch({ type: 'failed', error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
    [api],
  );

  const cancel = useCallback(async (): Promise<void> => {
    const jobId = jobIdRef.current;
    if (api === undefined || jobId === null) {
      return;
    }
    dispatch({ type: 'cancelling' });
    try {
      await api.cancelImport({ jobId });
    } catch {
      // The worker still emits a terminal progress event; that resolves the UI.
    }
  }, [api]);

  const reset = useCallback((): void => {
    jobIdRef.current = null;
    dispatch({ type: 'reset' });
  }, []);

  return { ...state, start, cancel, reset };
}
