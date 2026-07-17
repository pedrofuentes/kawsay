// Direct tests for the shared `useInfiniteQuery` accumulator primitive (#486). The
// append/paginated sibling of `useQuery`: a fetch-on-key read whose `loadMore`
// APPENDS the next page onto the accumulated list, with the SAME monotonic
// generation + mounted + abort race guard (a superseded in-flight page is dropped
// on settle, never clobbering a newer result). The load-bearing behaviours pinned
// here are the ones the migrated hooks (useTimeline #432, useCollectionItems)
// depend on: append across pages, latest-wins stale-drop, the unmount guard,
// reload-from-page-1, and the pending-refetch-while-in-flight re-run (#432).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useInfiniteQuery } from '@renderer/lib/use-infinite-query';

/** A hand-rolled deferred so a test can hold a page fetch IN FLIGHT on demand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useInfiniteQuery — append pagination', () => {
  it('appends each page onto the accumulated list across loadMore, threading the cursor', async () => {
    const fetchPage = vi.fn(async ({ mode, cursor }: { mode: 'initial' | 'more'; cursor: string | null }) => {
      if (mode === 'initial') return { items: ['a1', 'a2'], cursor: 'c1', hasMore: true };
      if (cursor === 'c1') return { items: ['b1'], cursor: 'c2', hasMore: true };
      return { items: ['d1'], cursor: null, hasMore: false };
    });
    const { result } = renderHook(() => useInfiniteQuery<string, string>({ key: 'k', fetchPage }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items).toEqual(['a1', 'a2']);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.items).toEqual(['a1', 'a2', 'b1']));
    expect(result.current.hasMore).toBe(true);
    // The second page was requested with the cursor the first page returned.
    expect(fetchPage.mock.calls[1]?.[0]).toMatchObject({ mode: 'more', cursor: 'c1' });

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.items).toEqual(['a1', 'a2', 'b1', 'd1']));
    expect(result.current.hasMore).toBe(false);
  });

  it('loadMore is inert once hasMore is exhausted', async () => {
    const fetchPage = vi.fn(async () => ({ items: ['only'], cursor: null, hasMore: false }));
    const { result } = renderHook(() => useInfiniteQuery<string, string>({ key: 'k', fetchPage }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      result.current.loadMore();
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

describe('useInfiniteQuery — offset accumulator shape (collections)', () => {
  it('passes the accumulated item count as `loaded` so an offset fetcher can page', async () => {
    const fetchPage = vi.fn(async ({ mode, loaded }: { mode: 'initial' | 'more'; loaded: number }) => {
      const offset = mode === 'more' ? loaded : 0;
      const items = offset === 0 ? ['m1', 'm2'] : ['m3'];
      const total = 3;
      return { items, cursor: null, hasMore: offset + items.length < total };
    });
    const { result } = renderHook(() => useInfiniteQuery<string>({ key: 'k', fetchPage }));
    await waitFor(() => expect(result.current.items).toEqual(['m1', 'm2']));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.items).toEqual(['m1', 'm2', 'm3']));
    expect(fetchPage.mock.calls[1]?.[0]).toMatchObject({ mode: 'more', loaded: 2 });
    expect(result.current.hasMore).toBe(false);
  });
});

describe('useInfiniteQuery — out-of-order race guard (latest-wins stale-drop)', () => {
  it('drops a superseded in-flight loadMore whose reload started after it', async () => {
    const more = deferred<{ items: string[]; cursor: string | null; hasMore: boolean }>();
    const reloadPage = deferred<{ items: string[]; cursor: string | null; hasMore: boolean }>();
    let call = 0;
    const fetchPage = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve({ items: ['p1'], cursor: 'c1', hasMore: true });
      if (call === 2) return more.promise;
      return reloadPage.promise;
    });
    const { result } = renderHook(() => useInfiniteQuery<string, string>({ key: 'k', fetchPage }));
    await waitFor(() => expect(result.current.items).toEqual(['p1']));

    // A loadMore is kicked off and held in flight.
    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

    // A reload arrives while that loadMore is still pending: it must supersede it
    // (bump the generation) and be remembered, not fired immediately.
    act(() => {
      result.current.reload();
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);

    // Settle the now-superseded loadMore: its page must NOT be appended.
    await act(async () => {
      more.resolve({ items: ['STALE'], cursor: null, hasMore: false });
      await more.promise;
    });
    // The remembered reload now runs.
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3));
    await act(async () => {
      reloadPage.resolve({ items: ['fresh'], cursor: null, hasMore: false });
      await reloadPage.promise;
    });
    await waitFor(() => expect(result.current.items).toEqual(['fresh']));
    expect(result.current.items).not.toContain('STALE');
  });
});

describe('useInfiniteQuery — unmount guard', () => {
  it('does not commit (or warn) when a page resolves after unmount', async () => {
    const pending = deferred<{ items: string[]; cursor: string | null; hasMore: boolean }>();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchPage = vi.fn(() => pending.promise);
    const { result, unmount } = renderHook(() => useInfiniteQuery<string, string>({ key: 'k', fetchPage }));
    expect(result.current.isFetching).toBe(true);

    unmount();
    await act(async () => {
      pending.resolve({ items: ['after-unmount'], cursor: null, hasMore: false });
      await pending.promise;
      await Promise.resolve();
    });
    const warned = errorSpy.mock.calls.some(
      (args) => typeof args[0] === 'string' && /unmounted/i.test(args[0]),
    );
    expect(warned).toBe(false);
  });
});

describe('useInfiniteQuery — reload from page 1', () => {
  it('reload discards the accumulated pages and refetches from the first page', async () => {
    let call = 0;
    const fetchPage = vi.fn(({ mode }: { mode: 'initial' | 'more' }) => {
      call += 1;
      if (mode === 'initial' && call === 1) return Promise.resolve({ items: ['a'], cursor: 'c1', hasMore: true });
      if (mode === 'more') return Promise.resolve({ items: ['b'], cursor: 'c2', hasMore: true });
      return Promise.resolve({ items: ['fresh'], cursor: null, hasMore: false });
    });
    const { result } = renderHook(() => useInfiniteQuery<string, string>({ key: 'k', fetchPage }));
    await waitFor(() => expect(result.current.items).toEqual(['a']));

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.items).toEqual(['a', 'b']));

    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.items).toEqual(['fresh']));
    expect(result.current.hasMore).toBe(false);
  });
});

describe('useInfiniteQuery — pending-refetch-while-in-flight re-run (#432)', () => {
  it('re-runs a reload requested while the initial fetch is still in flight', async () => {
    const mount = deferred<{ items: string[]; cursor: string | null; hasMore: boolean }>();
    let call = 0;
    const fetchPage = vi.fn(() => {
      call += 1;
      if (call === 1) return mount.promise;
      return Promise.resolve({ items: ['refreshed'], cursor: null, hasMore: false });
    });
    const { result } = renderHook(() => useInfiniteQuery<string, string>({ key: 'k', fetchPage }));

    // The mount fetch is in flight (deferred).
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('loading');

    // A reload arrives while the mount fetch is still pending. The mutex must not
    // silently drop it — it must be remembered and re-run once the fetch settles.
    act(() => {
      result.current.reload();
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);

    // Settle the in-flight mount fetch: its result is superseded and dropped.
    await act(async () => {
      mount.resolve({ items: ['stale'], cursor: null, hasMore: false });
      await mount.promise;
    });

    // The remembered reload now runs and its page wins.
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.items).toEqual(['refreshed']));
    expect(result.current.items).not.toContain('stale');
  });
});

describe('useInfiniteQuery — error surfacing', () => {
  it('surfaces the RAW rejection and keeps prior items when a loadMore fails, then retries', async () => {
    let call = 0;
    const cause = new Error('mid-scroll glitch');
    const fetchPage = vi.fn(({ mode }: { mode: 'initial' | 'more' }) => {
      call += 1;
      if (call === 1) return Promise.resolve({ items: ['a'], cursor: 'c1', hasMore: true });
      if (call === 2) return Promise.reject(cause);
      return Promise.resolve({ items: ['b'], cursor: null, hasMore: false });
    });
    const { result } = renderHook(() => useInfiniteQuery<string, string>({ key: 'k', fetchPage }));
    await waitFor(() => expect(result.current.items).toEqual(['a']));

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    // Raw cause surfaced verbatim; the already-loaded page and cursor are kept so
    // the same next page can be retried.
    expect(result.current.error).toBe(cause);
    expect(result.current.items).toEqual(['a']);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.items).toEqual(['a', 'b']));
    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeUndefined();
  });
});

describe('useInfiniteQuery — disabled/idle', () => {
  it('does not fetch while key is null and stays idle', async () => {
    const fetchPage = vi.fn(async () => ({ items: ['x'], cursor: null, hasMore: false }));
    const { result } = renderHook(() => useInfiniteQuery<string, string>({ key: null, fetchPage }));

    expect(result.current.status).toBe('idle');
    await Promise.resolve();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.current.items).toEqual([]);
    // Inert actions never throw or fetch while disabled.
    act(() => {
      result.current.loadMore();
      result.current.reload();
    });
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
