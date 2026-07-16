// The renderer-side reads for the Collections browser view (#437): the full
// list of a person's browsable collections, and one collection's
// offset-paginated members. Both mirror useTimeline's shape (a calm
// `unavailable` state when the preload bridge is missing, rather than
// throwing) — `useCollections` is a single flat read (a collections list is
// small and bounded), while `useCollectionItems` streams pages the same way
// `useTimeline` streams timeline pages, just keyed by offset instead of an
// opaque cursor (a collection's membership is stable, unlike the ever-growing
// timeline, so a plain running offset is enough).
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { CollectionItemsPageDTO, CollectionSummaryDTO, ItemCardDTO } from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';

export type CollectionsStatus = 'unavailable' | 'loading' | 'ready' | 'error';

export interface UseCollectionsResult {
  collections: CollectionSummaryDTO[];
  status: CollectionsStatus;
  /** Discard the current list and re-fetch (retry after an error). */
  reload: () => void;
}

/** Loads the full collections list (`catalog:listCollections`) once on mount. */
export function useCollections(): UseCollectionsResult {
  const api = useKawsayApi();
  const [collections, setCollections] = useState<CollectionSummaryDTO[]>([]);
  const [status, setStatus] = useState<CollectionsStatus>(api !== undefined ? 'loading' : 'unavailable');
  // Monotonic request id so a slow earlier read can never clobber a newer one
  // (e.g. a fast reload while the first fetch is still in flight).
  const requestId = useRef(0);

  const load = useCallback((): void => {
    if (api === undefined) {
      setStatus('unavailable');
      return;
    }
    const id = (requestId.current += 1);
    setStatus('loading');
    api
      .listCollections()
      .then((view) => {
        if (id !== requestId.current) return;
        setCollections(view.collections);
        setStatus('ready');
      })
      .catch(() => {
        if (id !== requestId.current) return;
        setStatus('error');
      });
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  return { collections, status, reload: load };
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
          dispatch({ type: 'fail', error: cause instanceof Error ? cause.message : String(cause) });
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
