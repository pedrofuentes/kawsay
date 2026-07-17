// Loads the catalog timeline one keyset page at a time through the typed bridge
// (newest first) and exposes a flat, growing list to the UI. Pagination follows
// the opaque cursor the main process returns; the renderer never builds offsets
// or touches the database. A missing bridge (browser preview) resolves to a calm
// `unavailable` state rather than throwing, mirroring useImport/useLibrary.
//
// The append accumulator, the inFlight+generation race guard, and the #432
// pending-refetch-while-in-flight re-run now all live in the shared
// {@link useInfiniteQuery} primitive (#486). `dataVersion` is folded into the
// query key, so a "catalog data changed" bump becomes a key change that discards
// the pages and refetches page 1 — deferred behind any in-flight fetch and
// re-run once it settles, exactly the #432 behaviour, now audited in one place.
import type { ItemCardDTO } from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';
import { ipcErrorCopy } from './ipc-error-copy';
import { useInfiniteQuery } from './use-infinite-query';

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

export function useTimeline(options: UseTimelineOptions = {}): UseTimelineResult {
  const pageSize = options.pageSize ?? DEFAULT_TIMELINE_PAGE_SIZE;
  const dataVersion = options.dataVersion ?? 0;
  const api = useKawsayApi();

  const query = useInfiniteQuery<ItemCardDTO, string>({
    // `null` while the bridge is missing keeps the query idle (mapped to
    // `unavailable`). Folding `dataVersion` into the key turns a catalog-changed
    // bump into a page-1 refetch (deferred behind any in-flight fetch, #432).
    key: api === undefined ? null : `timeline:${dataVersion}`,
    fetchPage: async ({ mode, cursor }) => {
      // `key` is non-null exactly when `api` is defined, so this only runs with a
      // live bridge.
      if (api === undefined) {
        return Promise.reject(new Error('bridge unavailable'));
      }
      const request =
        mode === 'more' && cursor !== null ? { limit: pageSize, cursor } : { limit: pageSize };
      const result = await api.getTimeline(request);
      return {
        items: result.items,
        cursor: result.nextCursor,
        hasMore: result.nextCursor !== null,
      };
    },
  });

  // Map the generic status onto the timeline's calm vocabulary. `idle` only arises
  // when the bridge is missing, so it reads as `unavailable`.
  const status: TimelineStatus =
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
    items: query.items,
    status,
    // Map the raw cause to copy the same way the bespoke reducer did.
    error: query.error != null ? ipcErrorCopy(query.error) : null,
    hasMore: query.hasMore,
    loadMore: query.loadMore,
    reload: query.reload,
  };
}
