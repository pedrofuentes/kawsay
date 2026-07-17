// The renderer's ONE keyed, race-guarded data-fetch primitive (#443). Every data
// hook used to hand-roll the same three things — loading/error state, refetch on
// mount/key-change, and race safety — each with its own bespoke guard (monotonic
// request ids in Search, an `inFlight`/`generation` pair in useTimeline, an
// `active` flag in the categorization/suggestion reads). Correct, but repetitive,
// and the source of three race regressions (#360, #383, #407). This collapses the
// read side of all of them into one audited place.
//
// The load-bearing invariant is the OUT-OF-ORDER guard: a fetch captures a
// monotonic generation when it starts, and its result is committed ONLY if that
// generation is still current AND the hook is still mounted. So an earlier-issued
// fetch that resolves AFTER a newer one (a slow first read overtaken by a refetch,
// or a stale key's read landing after a key switch) is dropped, never clobbering
// the newer result — the exact hazard the bespoke guards defended against.
//
// It stays dependency-free (ADR-0014/0015 — no react-query/swr): pure React refs
// plus a tiny module-level cache. The error is surfaced RAW (never mapped or
// swallowed) so the owning hook can still translate it via `ipcErrorCopy`.
import { useCallback, useEffect, useRef, useState } from 'react';

export type QueryStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseQueryOptions<T> {
  /**
   * The cache/identity key for this read. A CHANGE triggers a fresh fetch; `null`
   * (or `enabled: false`) disables the query and leaves it idle without fetching —
   * the way a hook expresses "no bridge yet" or "feature off".
   */
  key: string | null;
  /** Runs the actual read. Receives an `AbortSignal` that fires when the fetch is
   *  superseded (key change / refetch / unmount), for fetchers that can honour it.
   *  MUST report failure by returning a rejected promise, not by throwing
   *  synchronously — a sync throw escapes the race guard rather than becoming an
   *  `error` state (wrap risky work in the async body / `Promise.reject`). */
  fetcher: (signal: AbortSignal) => Promise<T>;
  /** Default true. When false the query is idle and never fetches (like `key: null`). */
  enabled?: boolean;
  /**
   * Opt-in stale-while-revalidate. When true, the last successful value for `key`
   * is retained in a module-level cache: a later mount for the same key shows it
   * IMMEDIATELY (no loading flash) while a background revalidation refreshes it —
   * the view-switch retention the timeline/collections navigation wanted. Off by
   * default, so a hook that opts out keeps the original fetch-every-mount behaviour.
   */
  cache?: boolean;
}

export interface UseQueryResult<T> {
  /** The latest committed value, or undefined before the first success. */
  data: T | undefined;
  /** The RAW rejection from the most recent failed fetch (undefined otherwise). */
  error: unknown;
  status: QueryStatus;
  /** True whenever a fetch is in flight (including a background revalidation). */
  isFetching: boolean;
  /** Re-run the fetcher for the current key. `showLoading` returns status to
   *  `loading` for the duration (a hard refresh); by default a revalidation keeps
   *  any current data visible. No-op while disabled. */
  refetch: (options?: { showLoading?: boolean }) => void;
  /** Imperatively set the data (and the cache entry, if caching) — the seam a
   *  mutation uses to write a server-returned view back into its query. */
  setData: (updater: T | ((prev: T | undefined) => T)) => void;
}

// A single module-level stale-while-revalidate store. Kept minimal on purpose: a
// last-value-per-key map, no TTL or eviction (the renderer's keyspace is tiny and
// bounded — a handful of catalog reads). `resetQueryCache` clears it so tests never
// leak a retained value from one case into the next. NOTE: keys share one flat
// namespace — a caching hook MUST use a globally-unique key string (there is no
// per-hook namespacing) or two hooks would read/write each other's cached value.
const queryCache = new Map<string, unknown>();

/** Clear the stale-while-revalidate cache. Call between tests (wired into the
 *  renderer test setup) so a cached value never leaks across cases. */
export function resetQueryCache(): void {
  queryCache.clear();
}

interface QueryState<T> {
  data: T | undefined;
  error: unknown;
  status: QueryStatus;
  isFetching: boolean;
}

export function useQuery<T>(options: UseQueryOptions<T>): UseQueryResult<T> {
  const { key, fetcher, enabled = true, cache = false } = options;
  const active = enabled && key !== null;

  // Seed from the cache so a cached key paints instantly (stale-while-revalidate)
  // instead of flashing a loading state on every mount.
  const [state, setState] = useState<QueryState<T>>(() => {
    if (active && cache && queryCache.has(key)) {
      return {
        data: queryCache.get(key) as T,
        error: undefined,
        status: 'success',
        isFetching: false,
      };
    }
    return {
      data: undefined,
      error: undefined,
      status: active ? 'loading' : 'idle',
      isFetching: false,
    };
  });

  // Monotonic fetch generation. Every fetch captures the value live at start; a
  // result whose generation is no longer current has been superseded (a newer
  // fetch, a key change, or an unmount) and is dropped on settle. This ONE guard
  // subsumes the monotonic-request-id / inFlight / active-flag / generation-counter
  // guards the individual hooks used to hand-roll.
  const generationRef = useRef(0);
  // False after unmount so a late resolve never calls setState on a dead tree.
  const mountedRef = useRef(true);
  // The current abort controller, aborted the moment a fetch is superseded.
  const controllerRef = useRef<AbortController | null>(null);

  // Latest fetcher/flags in refs so `run` stays a stable identity (it must not be
  // re-created on every render, or the mount effect would re-fire spuriously).
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

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

  const run = useCallback(
    (currentKey: string, showLoading: boolean): void => {
      // Supersede any in-flight fetch: bump the generation and abort the old signal.
      generationRef.current += 1;
      const myGeneration = generationRef.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      const hasStale = cacheRef.current && queryCache.has(currentKey);
      setState((prev) => ({
        // Keep any current/cached data visible during a soft revalidation, but a
        // caller that explicitly asks for a hard refresh (`showLoading`) ALWAYS
        // gets a visible loading state — even when a cached value exists — so the
        // cache can never silently downgrade a hard refresh into a background
        // revalidation (the data stays on screen while status reads `loading`).
        data: hasStale ? (queryCache.get(currentKey) as T) : prev.data,
        error: prev.error,
        status: showLoading
          ? 'loading'
          : hasStale
            ? 'success'
            : prev.status === 'idle'
              ? 'loading'
              : prev.status,
        isFetching: true,
      }));

      fetcherRef.current(controller.signal).then(
        (value) => {
          if (!mountedRef.current || myGeneration !== generationRef.current) {
            return;
          }
          if (cacheRef.current) {
            queryCache.set(currentKey, value);
          }
          setState({ data: value, error: undefined, status: 'success', isFetching: false });
        },
        (cause: unknown) => {
          if (!mountedRef.current || myGeneration !== generationRef.current) {
            return;
          }
          // Surface the RAW cause and keep any already-shown data — the owning hook
          // maps the cause to copy (e.g. ipcErrorCopy) and decides what to show.
          setState((prev) => ({
            data: prev.data,
            error: cause,
            status: 'error',
            isFetching: false,
          }));
        },
      );
    },
    [],
  );

  // Fetch on mount and whenever the key (or enabled) changes. A disabled query
  // resets to idle and supersedes any in-flight fetch so a late result is dropped.
  useEffect(() => {
    if (!active) {
      generationRef.current += 1;
      controllerRef.current?.abort();
      setState((prev) =>
        prev.status === 'idle' && !prev.isFetching
          ? prev
          : { data: undefined, error: undefined, status: 'idle', isFetching: false },
      );
      return;
    }
    run(key, false);
  }, [active, key, run]);

  const refetch = useCallback(
    (opts?: { showLoading?: boolean }): void => {
      if (!active) {
        return;
      }
      run(key, opts?.showLoading ?? false);
    },
    [active, key, run],
  );

  // Write through to the query's data (a synchronous, caller-driven update — e.g. an
  // optimistic toggle or an action repaint). NOTE: `setData` does NOT bump the fetch
  // generation, so a still-in-flight fetch settling AFTER a `setData` will overwrite
  // it (the fetch is not treated as superseded). Reachable only when a caller composes
  // `setData` with an outstanding fetch of the same key; a caller that gates its writes
  // behind the fetch having settled (`status !== 'loading'`) is unaffected.
  const setData = useCallback(
    (updater: T | ((prev: T | undefined) => T)): void => {
      setState((prev) => {
        const next =
          typeof updater === 'function'
            ? (updater as (p: T | undefined) => T)(prev.data)
            : updater;
        if (cacheRef.current && active && key !== null) {
          queryCache.set(key, next);
        }
        return { data: next, error: undefined, status: 'success', isFetching: prev.isFetching };
      });
    },
    [active, key],
  );

  return {
    data: state.data,
    error: state.error,
    status: state.status,
    isFetching: state.isFetching,
    refetch,
    setData,
  };
}
