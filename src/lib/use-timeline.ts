// Loads the catalog timeline one keyset page at a time through the typed bridge
// (newest first) and exposes a flat, growing list to the UI. Pagination follows
// the opaque cursor the main process returns; the renderer never builds offsets
// or touches the database. A missing bridge (browser preview) resolves to a calm
// `unavailable` state rather than throwing, mirroring useImport/useLibrary.
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ItemCardDTO } from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';

export type TimelineStatus = 'unavailable' | 'loading' | 'loadingMore' | 'ready' | 'error';

/** A calm default page size: large enough to fill a tall window in one fetch,
 *  well under the contract's hard `PAGE_LIMIT_MAX`. */
export const DEFAULT_TIMELINE_PAGE_SIZE = 60;

export interface UseTimelineOptions {
  pageSize?: number;
}

export interface UseTimelineResult {
  items: ItemCardDTO[];
  status: TimelineStatus;
  error: string | null;
  hasMore: boolean;
  /** Fetch the next page (no-op while one is in flight, exhausted, or unavailable). */
  loadMore: () => void;
  /** Discard everything and reload the first page (used for retry after an error). */
  reload: () => void;
}

interface TimelineState {
  items: ItemCardDTO[];
  status: TimelineStatus;
  error: string | null;
  cursor: string | null;
  hasMore: boolean;
}

type Action =
  | { type: 'load-start' }
  | { type: 'load-more-start' }
  | { type: 'page'; items: ItemCardDTO[]; nextCursor: string | null; append: boolean }
  | { type: 'fail'; error: string };

function initialState(available: boolean): TimelineState {
  return {
    items: [],
    status: available ? 'loading' : 'unavailable',
    error: null,
    cursor: null,
    hasMore: false,
  };
}

function reducer(state: TimelineState, action: Action): TimelineState {
  switch (action.type) {
    case 'load-start':
      return { items: [], status: 'loading', error: null, cursor: null, hasMore: false };
    case 'load-more-start':
      return state.status === 'ready' && state.hasMore
        ? { ...state, status: 'loadingMore' }
        : state;
    case 'page': {
      const items = action.append ? [...state.items, ...action.items] : action.items;
      return {
        items,
        status: 'ready',
        error: null,
        cursor: action.nextCursor,
        hasMore: action.nextCursor !== null,
      };
    }
    case 'fail':
      return { ...state, status: 'error', error: action.error };
    default:
      return state;
  }
}

export function useTimeline(options: UseTimelineOptions = {}): UseTimelineResult {
  const pageSize = options.pageSize ?? DEFAULT_TIMELINE_PAGE_SIZE;
  const api = useKawsayApi();
  const [state, dispatch] = useReducer(reducer, api !== undefined, initialState);

  // Mirror state into a ref so the fetcher reads fresh cursor/status without being
  // re-created on every render (which would re-trigger the mount effect).
  const stateRef = useRef(state);
  stateRef.current = state;
  const inFlight = useRef(false);

  const fetchPage = useCallback(
    async (mode: 'initial' | 'more'): Promise<void> => {
      if (api === undefined || inFlight.current) {
        return;
      }
      const current = stateRef.current;
      if (
        mode === 'more' &&
        (!current.hasMore || current.cursor === null || current.status !== 'ready')
      ) {
        return;
      }

      inFlight.current = true;
      dispatch(mode === 'initial' ? { type: 'load-start' } : { type: 'load-more-start' });
      try {
        const request =
          mode === 'more' && current.cursor !== null
            ? { limit: pageSize, cursor: current.cursor }
            : { limit: pageSize };
        const result = await api.getTimeline(request);
        dispatch({
          type: 'page',
          items: result.items,
          nextCursor: result.nextCursor,
          append: mode === 'more',
        });
      } catch (cause) {
        dispatch({ type: 'fail', error: cause instanceof Error ? cause.message : String(cause) });
      } finally {
        inFlight.current = false;
      }
    },
    [api, pageSize],
  );

  useEffect(() => {
    if (api !== undefined) {
      void fetchPage('initial');
    }
  }, [api, fetchPage]);

  const loadMore = useCallback(() => {
    void fetchPage('more');
  }, [fetchPage]);

  const reload = useCallback(() => {
    void fetchPage('initial');
  }, [fetchPage]);

  return {
    items: state.items,
    status: state.status,
    error: state.error,
    hasMore: state.hasMore,
    loadMore,
    reload,
  };
}
