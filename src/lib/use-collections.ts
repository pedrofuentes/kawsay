// The renderer-side reads for the Collections browser view (#437): the full
// list of a person's browsable collections, and one collection's
// offset-paginated members. Both mirror useTimeline's shape (a calm
// `unavailable` state when the preload bridge is missing, rather than
// throwing) — `useCollections` is a single flat read (a collections list is
// small and bounded), while `useCollectionItems` streams pages the same way
// `useTimeline` streams timeline pages, just keyed by offset instead of an
// opaque cursor (a collection's membership is stable, unlike the ever-growing
// timeline, so a plain running offset is enough).
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { CollectionItemsPageDTO, CollectionSummaryDTO, ItemCardDTO } from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';
import { ipcErrorCopy } from './ipc-error-copy';
import { useQuery } from './use-query';

export type CollectionsStatus = 'unavailable' | 'loading' | 'ready' | 'error';

export interface UseCollectionsResult {
  collections: CollectionSummaryDTO[];
  status: CollectionsStatus;
  /** Discard the current list and re-fetch (retry after an error). */
  reload: () => void;
}

/**
 * Loads the full collections list (`catalog:listCollections`) on mount. The
 * monotonic-request-id race guard this used to hand-roll (so a slow earlier read
 * never clobbers a newer one) now lives in the shared {@link useQuery} primitive
 * (#443); opting into its stale-while-revalidate cache means returning to the
 * Collections view paints the last list instantly and revalidates in the
 * background, rather than flashing a loading state on every visit.
 */
export function useCollections(): UseCollectionsResult {
  const api = useKawsayApi();
  const query = useQuery({
    // `null` while the bridge is missing (browser preview) keeps the query idle —
    // mapped to the calm `unavailable` state below, never a fetch.
    key: api === undefined ? null : 'collections',
    fetcher: () => {
      // `key` is non-null exactly when `api` is defined, so this is only ever
      // invoked with a live bridge.
      if (api === undefined) {
        return Promise.reject(new Error('bridge unavailable'));
      }
      return api.listCollections().then((view) => view.collections);
    },
    cache: true,
  });

  // Map the generic query status onto the view's calm vocabulary. `idle` only
  // arises here when the bridge is missing, so it reads as `unavailable`.
  const status: CollectionsStatus =
    api === undefined
      ? 'unavailable'
      : query.status === 'success'
        ? 'ready'
        : query.status === 'error'
          ? 'error'
          : 'loading';

  const { refetch } = query;
  const reload = useCallback((): void => {
    // Mirror the original reload: return to a visible loading state while the
    // retry is in flight (a hard refresh, not a silent background revalidation).
    refetch({ showLoading: true });
  }, [refetch]);

  return { collections: query.data ?? [], status, reload };
}

/** A calm default page size — the same order of magnitude as the timeline's,
 *  well under the contract's hard PAGE_LIMIT_MAX. */
export const DEFAULT_COLLECTION_PAGE_SIZE = 60;

export type CollectionItemsStatus = 'unavailable' | 'loading' | 'loadingMore' | 'ready' | 'error';

export interface UseCollectionItemsResult {
  /** The collection's own summary once the first page has loaded, else null. */
  collection: CollectionSummaryDTO | null;
  items: ItemCardDTO[];
  status: CollectionItemsStatus;
  error: string | null;
  hasMore: boolean;
  /** Fetch the next page (no-op while one is in flight, exhausted, or unavailable). */
  loadMore: () => void;
  /** Discard everything and reload the first page (used for retry after an error). */
  reload: () => void;
}

interface CollectionItemsState {
  collection: CollectionSummaryDTO | null;
  items: ItemCardDTO[];
  status: CollectionItemsStatus;
  error: string | null;
  hasMore: boolean;
}

type Action =
  | { type: 'load-start' }
  | { type: 'load-more-start' }
  | { type: 'page'; page: CollectionItemsPageDTO; append: boolean }
  | { type: 'fail'; error: string };

function initialState(available: boolean): CollectionItemsState {
  return {
    collection: null,
    items: [],
    status: available ? 'loading' : 'unavailable',
    error: null,
    hasMore: false,
  };
}

function reducer(state: CollectionItemsState, action: Action): CollectionItemsState {
  switch (action.type) {
    case 'load-start':
      return { collection: null, items: [], status: 'loading', error: null, hasMore: false };
    case 'load-more-start':
      return (state.status === 'ready' || state.status === 'error') && state.hasMore
        ? { ...state, status: 'loadingMore', error: null }
        : state;
    case 'page': {
      const items = action.append ? [...state.items, ...action.page.items] : action.page.items;
      return {
        collection: action.page.collection,
        items,
        status: 'ready',
        error: null,
        hasMore: items.length < action.page.total,
      };
    }
    case 'fail':
      return { ...state, status: 'error', error: action.error };
    default:
      return state;
  }
}

/** Loads ONE collection's offset-paginated members (`catalog:getCollection`),
 *  fetching the first page on mount (and again whenever `collectionId`
 *  changes) and streaming further pages via `loadMore`. */
export function useCollectionItems(
  collectionId: string,
  options: { pageSize?: number } = {},
): UseCollectionItemsResult {
  const pageSize = options.pageSize ?? DEFAULT_COLLECTION_PAGE_SIZE;
  const api = useKawsayApi();
  const [state, dispatch] = useReducer(reducer, api !== undefined, initialState);

  // Mirror state into a ref so the fetcher reads a fresh item count / status
  // without being re-created on every render (mirrors useTimeline).
  const stateRef = useRef(state);
  stateRef.current = state;
  const inFlight = useRef(false);
  // A fetch whose generation is no longer current on settle is superseded (a
  // newer initial fetch started, e.g. collectionId changed) and its result is
  // dropped rather than clobbering the newer one (mirrors useTimeline).
  const generation = useRef(0);

  const fetchPage = useCallback(
    async (mode: 'initial' | 'more'): Promise<void> => {
      if (api === undefined) {
        return;
      }
      if (inFlight.current) {
        return;
      }
      const current = stateRef.current;
      if (
        mode === 'more' &&
        (!current.hasMore || (current.status !== 'ready' && current.status !== 'error'))
      ) {
        return;
      }

      inFlight.current = true;
      const myGeneration = generation.current;
      dispatch(mode === 'initial' ? { type: 'load-start' } : { type: 'load-more-start' });
      try {
        const offset = mode === 'more' ? current.items.length : 0;
        const page = await api.getCollection({ id: collectionId, limit: pageSize, offset });
        if (myGeneration === generation.current) {
          dispatch({ type: 'page', page, append: mode === 'more' });
        }
      } catch (cause) {
        if (myGeneration === generation.current) {
          dispatch({ type: 'fail', error: ipcErrorCopy(cause) });
        }
      } finally {
        inFlight.current = false;
      }
    },
    [api, collectionId, pageSize],
  );

  // Fetch page 1 on mount, and again whenever `collectionId` (or `api`)
  // changes — `fetchPage`'s own identity already changes with `collectionId`,
  // so this re-fires exactly on a genuine change (mirrors useTimeline).
  useEffect(() => {
    generation.current += 1;
    if (api !== undefined) {
      void fetchPage('initial');
    }
  }, [api, fetchPage]);

  const loadMore = useCallback((): void => {
    void fetchPage('more');
  }, [fetchPage]);

  const reload = useCallback((): void => {
    generation.current += 1;
    void fetchPage('initial');
  }, [fetchPage]);

  return {
    collection: state.collection,
    items: state.items,
    status: state.status,
    error: state.error,
    hasMore: state.hasMore,
    loadMore,
    reload,
  };
}
