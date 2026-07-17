// The renderer-side reads for the Collections browser view (#437): the full
// list of a person's browsable collections, and one collection's
// offset-paginated members. Both mirror useTimeline's shape (a calm
// `unavailable` state when the preload bridge is missing, rather than
// throwing) — `useCollections` is a single flat read (a collections list is
// small and bounded), while `useCollectionItems` streams pages the same way
// `useTimeline` streams timeline pages, just keyed by offset instead of an
// opaque cursor (a collection's membership is stable, unlike the ever-growing
// timeline, so a plain running offset is enough).
import { useCallback } from 'react';
import type { CollectionSummaryDTO, ItemCardDTO } from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';
import { ipcErrorCopy } from './ipc-error-copy';
import { useInfiniteQuery } from './use-infinite-query';
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

/** Loads ONE collection's offset-paginated members (`catalog:getCollection`),
 *  fetching the first page on mount (and again whenever `collectionId`
 *  changes) and streaming further pages via `loadMore`. The append accumulator
 *  and the inFlight+generation race guard now live in the shared
 *  {@link useInfiniteQuery} primitive (#486); `collectionId` is its key, so a
 *  collection switch discards the pages and refetches page 1. The offset is the
 *  accumulated item count the primitive threads as `loaded`, and the collection
 *  summary rides along as the page `meta`. */
export function useCollectionItems(
  collectionId: string,
  options: { pageSize?: number } = {},
): UseCollectionItemsResult {
  const pageSize = options.pageSize ?? DEFAULT_COLLECTION_PAGE_SIZE;
  const api = useKawsayApi();

  const query = useInfiniteQuery<ItemCardDTO, string, CollectionSummaryDTO>({
    // `null` while the bridge is missing keeps the query idle (mapped to
    // `unavailable`); otherwise the collection id is the identity key.
    key: api === undefined ? null : collectionId,
    fetchPage: async ({ mode, loaded }) => {
      // `key` is non-null exactly when `api` is defined.
      if (api === undefined) {
        return Promise.reject(new Error('bridge unavailable'));
      }
      const offset = mode === 'more' ? loaded : 0;
      const page = await api.getCollection({ id: collectionId, limit: pageSize, offset });
      return {
        items: page.items,
        // Offset pagination: no opaque cursor, hasMore is derived from the total.
        cursor: null,
        hasMore: offset + page.items.length < page.total,
        meta: page.collection,
      };
    },
  });

  const status: CollectionItemsStatus =
    api === undefined
      ? 'unavailable'
      : query.status === 'ready'
        ? 'ready'
        : query.status === 'loadingMore'
          ? 'loadingMore'
          : query.status === 'error'
            ? 'error'
            : 'loading';

  return {
    collection: query.meta ?? null,
    items: query.items,
    status,
    error: query.error != null ? ipcErrorCopy(query.error) : null,
    hasMore: query.hasMore,
    loadMore: query.loadMore,
    reload: query.reload,
  };
}
