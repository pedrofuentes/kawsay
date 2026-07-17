// The renderer's ONE keyed, race-guarded ACCUMULATOR primitive (#486) — the
// append/paginated sibling of `useQuery` (#443). Where `useQuery` commits a
// single value per key, this one accumulates: a first page on key-change/mount
// and a `loadMore` that APPENDS the next page, exposing the growing flat list.
// The timeline and the collection-members reads each hand-rolled the same
// `useReducer` accumulator with an `inFlight` mutex, a monotonic `generation`,
// and (in the timeline) the #432 `pendingRefetch` re-run; this collapses both
// onto one audited place.
//
// The load-bearing invariants, carried over verbatim from those guards:
//   • OUT-OF-ORDER drop — every fetch captures a monotonic generation at start
//     and commits only if that generation is still current (and the hook is
//     still mounted), so a stale in-flight page (e.g. a background `loadMore`)
//     can never clobber a newer reload's result.
//   • PENDING-REFETCH re-run (#432) — a reload (or key-change) requested WHILE a
//     fetch is in flight must not be lost to the `inFlight` mutex: it supersedes
//     the in-flight fetch (bumping the generation so its result is dropped) and
//     is REMEMBERED, then re-run once the mutex clears. Without this a just-
//     completed import stays invisible until an app relaunch.
//   • A `more` requested mid-flight stays an inert no-op — the in-flight fetch
//     owns the next page.
//
// Dependency-free (ADR-0014/0015 — no react-query/swr): pure React refs. The
// error is surfaced RAW (never mapped or swallowed) so the owning hook can still
// translate it via `ipcErrorCopy`. Modelled on `useQuery`'s conventions.
import { useCallback, useEffect, useRef, useState } from 'react';

export type InfiniteQueryStatus = 'idle' | 'loading' | 'loadingMore' | 'ready' | 'error';

/** One page's worth of results returned by {@link UseInfiniteQueryOptions.fetchPage}. */
export interface InfiniteQueryPage<TItem, TCursor = unknown, TMeta = unknown> {
  /** This page's items — appended (a `more` fetch) or replacing (an `initial` fetch). */
  items: TItem[];
  /** Whether further pages remain. The fetcher owns this decision so it can derive
   *  it from either an opaque cursor (timeline) or an offset/total (collections). */
  hasMore: boolean;
  /** An opaque cursor to thread into the NEXT `more` fetch. Offset-paginated
   *  fetchers that key off `loaded` instead can leave it null. */
  cursor?: TCursor | null;
  /** Optional per-response metadata surfaced as `meta` (e.g. a collection summary
   *  carried alongside its members). Reset to undefined while a fresh page loads. */
  meta?: TMeta;
}

/** The context a page fetch receives. Covers BOTH pagination shapes: a
 *  cursor-threaded fetcher reads `cursor`; an offset fetcher reads `loaded`. */
export interface InfiniteFetchContext<TCursor = unknown> {
  mode: 'initial' | 'more';
  /** The cursor the previous page returned (null on an initial fetch). */
  cursor: TCursor | null;
  /** How many items are accumulated so far (0 on an initial fetch) — the offset
   *  an offset-paginated fetcher fetches from. */
  loaded: number;
  /** Fires when this fetch is superseded (key change / reload / unmount), for
   *  fetchers that can honour it. */
  signal: AbortSignal;
}

export interface UseInfiniteQueryOptions<TItem, TCursor = unknown, TMeta = unknown> {
  /**
   * The identity key for this accumulator. A CHANGE discards the accumulated
   * pages and refetches from page 1 (deferred behind any in-flight fetch, like a
   * reload); `null` (or `enabled: false`) disables the query and leaves it idle —
   * the way a hook expresses "no bridge yet" or "feature off".
   */
  key: string | null;
  /** Default true. When false the query is idle and never fetches (like `key: null`). */
  enabled?: boolean;
  /** Fetches ONE page. MUST report failure by returning a rejected promise, not by
   *  throwing synchronously (a sync throw escapes the race guard). */
  fetchPage: (context: InfiniteFetchContext<TCursor>) => Promise<InfiniteQueryPage<TItem, TCursor, TMeta>>;
}

export interface UseInfiniteQueryResult<TItem, TMeta = unknown> {
  /** The accumulated, appended list. */
  items: TItem[];
  /** The most recent committed page's metadata (undefined before the first page
   *  and while a fresh first page loads). */
  meta: TMeta | undefined;
  status: InfiniteQueryStatus;
  /** The RAW rejection from the most recent failed fetch (undefined otherwise). */
  error: unknown;
  /** Whether further pages remain (drives a "Load more" affordance). */
  hasMore: boolean;
  /** True whenever a page fetch is in flight. */
  isFetching: boolean;
  /** Fetch the next page and APPEND it (no-op while a fetch is in flight, the list
   *  is exhausted, or the query is disabled). */
  loadMore: () => void;
  /** Discard the accumulated pages and refetch from page 1 (retry after an error /
   *  a data-changed refresh). A reload requested mid-flight is remembered and
   *  re-run once the in-flight fetch settles (#432). */
  reload: () => void;
}

interface InfiniteState<TItem, TCursor, TMeta> {
  items: TItem[];
  meta: TMeta | undefined;
  cursor: TCursor | null;
  hasMore: boolean;
  status: InfiniteQueryStatus;
  error: unknown;
  isFetching: boolean;
}

export function useInfiniteQuery<TItem, TCursor = unknown, TMeta = unknown>(
  options: UseInfiniteQueryOptions<TItem, TCursor, TMeta>,
): UseInfiniteQueryResult<TItem, TMeta> {
  const { key, fetchPage, enabled = true } = options;
  const active = enabled && key !== null;

  const [state, setState] = useState<InfiniteState<TItem, TCursor, TMeta>>(() => ({
    items: [],
    meta: undefined,
    cursor: null,
    hasMore: false,
    status: active ? 'loading' : 'idle',
    error: undefined,
    isFetching: false,
  }));

  // Mirror state into a ref so `run` reads a fresh cursor/status/item-count
  // without being re-created on every render (which would re-fire the mount
  // effect). Mirrors useQuery/useTimeline.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Latest fetcher/active flag in refs so `run` keeps a stable identity.
  const fetchPageRef = useRef(fetchPage);
  fetchPageRef.current = fetchPage;
  const activeRef = useRef(active);
  activeRef.current = active;

  // The `inFlight` mutex: at most one fetch runs at a time.
  const inFlightRef = useRef(false);
  // A reload/key-change requested while a fetch was in flight, remembered so it can
  // be re-run once the mutex clears (#432). It is NOT lost to the mutex.
  const pendingReloadRef = useRef(false);
  // Monotonic fetch generation, bumped the moment a fetch is SUPERSEDED (a reload
  // arriving mid-flight, or an unmount/disable). A settle whose generation is no
  // longer current is dropped, so a stale page never clobbers a newer result.
  const generationRef = useRef(0);
  // False after unmount so a late settle never calls setState on a dead tree.
  const mountedRef = useRef(true);
  // The current fetch's abort controller, aborted the moment it is superseded.
  const controllerRef = useRef<AbortController | null>(null);
  // A stable indirection so `run` can re-invoke itself (to run a pending reload)
  // without listing itself as a dependency.
  const runRef = useRef<(mode: 'initial' | 'more') => void>();

  const run = useCallback((mode: 'initial' | 'more'): void => {
    if (!mountedRef.current || !activeRef.current) {
      return;
    }
    if (inFlightRef.current) {
      // A fetch is already running. A reload/key-change (an `initial`) can't be
      // dropped: remember it and supersede the in-flight fetch (bump the
      // generation + abort) so its now-stale result won't clobber the reload we
      // run once it settles. A `more` mid-flight stays an inert no-op — the
      // in-flight fetch owns the next page.
      if (mode === 'initial') {
        pendingReloadRef.current = true;
        generationRef.current += 1;
        controllerRef.current?.abort();
      }
      return;
    }

    const current = stateRef.current;
    if (
      mode === 'more' &&
      (!current.hasMore || (current.status !== 'ready' && current.status !== 'error'))
    ) {
      return;
    }

    inFlightRef.current = true;
    const myGeneration = generationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;

    setState((prev) =>
      mode === 'initial'
        ? {
            items: [],
            meta: undefined,
            cursor: null,
            hasMore: false,
            status: 'loading',
            error: undefined,
            isFetching: true,
          }
        : { ...prev, status: 'loadingMore', error: undefined, isFetching: true },
    );

    const context: InfiniteFetchContext<TCursor> = {
      mode,
      cursor: mode === 'more' ? current.cursor : null,
      loaded: mode === 'more' ? current.items.length : 0,
      signal: controller.signal,
    };

    void (async () => {
      try {
        const page = await fetchPageRef.current(context);
        if (!mountedRef.current || myGeneration !== generationRef.current) {
          return;
        }
        setState((prev) => ({
          items: mode === 'more' ? [...prev.items, ...page.items] : page.items,
          meta: page.meta,
          cursor: page.cursor ?? null,
          hasMore: page.hasMore,
          status: 'ready',
          error: undefined,
          isFetching: false,
        }));
      } catch (cause) {
        if (!mountedRef.current || myGeneration !== generationRef.current) {
          return;
        }
        // Surface the RAW cause and keep any already-shown page (and its cursor) so
        // the same next page can be retried; the owning hook maps the cause to copy.
        setState((prev) => ({ ...prev, status: 'error', error: cause, isFetching: false }));
      } finally {
        // Only release the mutex / run a pending reload if THIS fetch still owns
        // it. A superseded fetch that a newer one has replaced (its controller is
        // no longer current — e.g. a disable force-cleared the mutex mid-flight
        // and a re-enable started a fresh fetch) must not clear the mutex out from
        // under the live fetch, or "at most one fetch in flight" breaks and a
        // reload would spawn a redundant concurrent fetch. This is a no-op for a
        // superseded old fetch, and still fires for the #432 pending-reload path
        // (which aborts the controller but does not replace it).
        if (controllerRef.current === controller) {
          inFlightRef.current = false;
          // A reload remembered mid-flight runs now that the mutex is clear. It
          // starts a fresh page-1 fetch at the already-bumped generation, so it
          // strictly succeeds the stale one.
          if (pendingReloadRef.current) {
            pendingReloadRef.current = false;
            runRef.current?.('initial');
          }
        }
      }
    })();
  }, []);
  runRef.current = run;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Supersede any in-flight fetch so its late settle is dropped, and signal
      // abort for fetchers that honour it.
      generationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, []);

  // Fetch page 1 on mount and whenever the key (or enabled) changes. A disabled
  // query resets to idle and supersedes any in-flight fetch.
  useEffect(() => {
    if (!active) {
      generationRef.current += 1;
      controllerRef.current?.abort();
      inFlightRef.current = false;
      pendingReloadRef.current = false;
      setState((prev) =>
        prev.status === 'idle' && !prev.isFetching
          ? prev
          : {
              items: [],
              meta: undefined,
              cursor: null,
              hasMore: false,
              status: 'idle',
              error: undefined,
              isFetching: false,
            },
      );
      return;
    }
    run('initial');
  }, [active, key, run]);

  const loadMore = useCallback((): void => {
    runRef.current?.('more');
  }, []);

  const reload = useCallback((): void => {
    runRef.current?.('initial');
  }, []);

  return {
    items: state.items,
    meta: state.meta,
    status: state.status,
    error: state.error,
    hasMore: state.hasMore,
    isFetching: state.isFetching,
    loadMore,
    reload,
  };
}
