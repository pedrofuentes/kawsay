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
  /**
   * A monotonic "catalog data changed" signal (owned by NavigationProvider).
   * When it changes, the hook discards its pages and refetches page 1 — the
   * mounted-timeline (#432) needs this because it no longer remounts to pick up
   * a completed import. Left at its default (0) it never triggers a refetch, so
   * a hook used without it behaves exactly as before.
   */
  dataVersion?: number;
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
      // Allow a retry from the error state too: a mid-scroll page failed but the
      // cursor was preserved, so the same next page can be re-requested. Clear the
      // stale message while the retry is in flight.
      return (state.status === 'ready' || state.status === 'error') && state.hasMore
        ? { ...state, status: 'loadingMore', error: null }
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
  const dataVersion = options.dataVersion ?? 0;
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
        (!current.hasMore ||
          current.cursor === null ||
          // 'ready' is the normal case; 'error' lets the user retry a page that
          // failed mid-scroll (the cursor was kept). 'loading'/'loadingMore' are
          // already covered by the inFlight guard above.
          (current.status !== 'ready' && current.status !== 'error'))
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

  // Fetch page 1 on mount, and again whenever `dataVersion` changes — a real
  // catalog mutation (a completed import; #432 review). `fetchPage` is stable
  // across `dataVersion` ticks (its deps are only api + pageSize), so this
  // fires exactly once per genuine change, never on an incidental re-render. A
  // consumer that passes no `dataVersion` pins it at 0, so this reduces to the
  // original mount-only fetch.
  useEffect(() => {
    if (api !== undefined) {
      void fetchPage('initial');
    }
  }, [api, fetchPage, dataVersion]);

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
