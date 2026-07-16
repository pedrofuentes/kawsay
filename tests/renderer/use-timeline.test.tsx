import { describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { useTimeline } from '@renderer/lib/use-timeline';
import type { KawsayAPI, TimelinePageDTO } from '@shared/kawsay-api';
import { makeFakeApi, makeItemCard } from './support/fake-api';
import type { FakeApi } from './support/fake-api';

function wrapper(api?: FakeApi) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <KawsayApiProvider api={api}>{children}</KawsayApiProvider>;
  };
}

function page(over: Partial<TimelinePageDTO> = {}): TimelinePageDTO {
  return { items: [], nextCursor: null, ...over };
}

/** A promise whose resolution we drive by hand, so a fetch can be held IN FLIGHT
 *  across a `dataVersion` bump — the interleaving the #432 refetch race needs. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useTimeline', () => {
  it('loads the first page through the typed bridge on mount', async () => {
    const items = [makeItemCard({ id: '11111111-2222-4333-8444-555555550001' })];
    const getTimeline = vi.fn<KawsayAPI['getTimeline']>(() =>
      Promise.resolve(page({ items, nextCursor: null })),
    );
    const api = makeFakeApi({ getTimeline });
    const { result } = renderHook(() => useTimeline(), { wrapper: wrapper(api) });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(getTimeline).toHaveBeenCalledTimes(1);
    expect(getTimeline.mock.calls[0]?.[0]).toMatchObject({ limit: expect.any(Number) });
    expect(getTimeline.mock.calls[0]?.[0]).not.toHaveProperty('cursor');
    expect(result.current.items).toHaveLength(1);
    expect(result.current.hasMore).toBe(false);
  });

  it('streams the next page through the cursor and appends, never refetching the first', async () => {
    const first = [makeItemCard({ id: '11111111-2222-4333-8444-555555550001' })];
    const second = [makeItemCard({ id: '11111111-2222-4333-8444-555555550002' })];
    const getTimeline = vi
      .fn()
      .mockResolvedValueOnce(page({ items: first, nextCursor: 'cursor-2' }))
      .mockResolvedValueOnce(page({ items: second, nextCursor: null }));
    const api = makeFakeApi({ getTimeline });
    const { result } = renderHook(() => useTimeline(), { wrapper: wrapper(api) });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      result.current.loadMore();
    });

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(getTimeline).toHaveBeenCalledTimes(2);
    expect(getTimeline.mock.calls[1]?.[0]).toMatchObject({ cursor: 'cursor-2' });
    expect(result.current.hasMore).toBe(false);
    expect(result.current.items.map((i) => i.id)).toEqual([
      '11111111-2222-4333-8444-555555550001',
      '11111111-2222-4333-8444-555555550002',
    ]);
  });

  it('does not page past the end (loadMore is inert once the cursor is exhausted)', async () => {
    const getTimeline = vi.fn(() =>
      Promise.resolve(page({ items: [makeItemCard()], nextCursor: null })),
    );
    const api = makeFakeApi({ getTimeline });
    const { result } = renderHook(() => useTimeline(), { wrapper: wrapper(api) });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      result.current.loadMore();
    });
    expect(getTimeline).toHaveBeenCalledTimes(1);
  });

  it('surfaces a load failure as an error state and recovers on reload', async () => {
    const getTimeline = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk hiccup'))
      .mockResolvedValueOnce(page({ items: [makeItemCard()], nextCursor: null }));
    const api = makeFakeApi({ getTimeline });
    const { result } = renderHook(() => useTimeline(), { wrapper: wrapper(api) });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeTruthy();

    await act(async () => {
      result.current.reload();
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('retries the next page from an error state, keeping the items already loaded (#101)', async () => {
    const first = [makeItemCard({ id: '11111111-2222-4333-8444-555555550001' })];
    const second = [makeItemCard({ id: '11111111-2222-4333-8444-555555550002' })];
    const getTimeline = vi
      .fn()
      .mockResolvedValueOnce(page({ items: first, nextCursor: 'cursor-2' }))
      .mockRejectedValueOnce(new Error('mid-scroll glitch'))
      .mockResolvedValueOnce(page({ items: second, nextCursor: null }));
    const api = makeFakeApi({ getTimeline });
    const { result } = renderHook(() => useTimeline(), { wrapper: wrapper(api) });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.hasMore).toBe(true);

    // A later page fails: the error is surfaced but the first page is kept and the
    // cursor stays put so the same page can be retried.
    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.hasMore).toBe(true);

    // loadMore from the error state retries that same next page and recovers.
    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeNull();
    expect(getTimeline).toHaveBeenCalledTimes(3);
    expect(getTimeline.mock.calls[1]?.[0]).toMatchObject({ cursor: 'cursor-2' });
    expect(getTimeline.mock.calls[2]?.[0]).toMatchObject({ cursor: 'cursor-2' });
  });

  // ── #432 race: a dataVersion refetch requested WHILE a fetch is in flight ──
  // The mounted-hidden timeline bumps `dataVersion` on import completion to pull
  // page 1 again. If that bump lands while the mount fetch (or a background
  // loadMore) is still settling, the `inFlight` mutex made `fetchPage` a silent,
  // never-retried no-op — the freshly imported memories stayed INVISIBLE until a
  // relaunch (regression B, now via a race). The refetch must survive the mutex.
  it('re-runs a dataVersion refetch requested while the mount fetch is still in flight (#432)', async () => {
    const oldItems = [makeItemCard({ id: '11111111-2222-4333-8444-555555550001', title: 'An older memory' })];
    const refreshed = [
      makeItemCard({ id: '11111111-2222-4333-8444-555555550001', title: 'An older memory' }),
      makeItemCard({ id: '11111111-2222-4333-8444-555555550002', title: 'A freshly imported memory' }),
    ];
    const mountFetch = deferred<TimelinePageDTO>();
    const getTimeline = vi
      .fn<KawsayAPI['getTimeline']>()
      .mockReturnValueOnce(mountFetch.promise)
      .mockResolvedValueOnce(page({ items: refreshed, nextCursor: null }));
    const api = makeFakeApi({ getTimeline });
    const { result, rerender } = renderHook(({ dataVersion }) => useTimeline({ dataVersion }), {
      wrapper: wrapper(api),
      initialProps: { dataVersion: 0 },
    });

    // The mount fetch is in flight (deferred, unresolved).
    expect(getTimeline).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('loading');

    // An import completes: bump dataVersion WHILE the mount fetch is still pending.
    // The refetch effect fires but the fetch is mutexed — it must be remembered,
    // not dropped.
    rerender({ dataVersion: 1 });
    expect(getTimeline).toHaveBeenCalledTimes(1);

    // Let the in-flight mount fetch settle.
    await act(async () => {
      mountFetch.resolve(page({ items: oldItems, nextCursor: null }));
      await mountFetch.promise;
    });

    // The remembered refetch must now run and surface the freshly imported memory
    // — it must not stay invisible until an app relaunch.
    await waitFor(() => expect(getTimeline).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.items.map((i) => i.id)).toEqual([
      '11111111-2222-4333-8444-555555550001',
      '11111111-2222-4333-8444-555555550002',
    ]);
  });

  it('does not let a stale in-flight loadMore clobber a dataVersion refetch (#432)', async () => {
    const firstPage = [makeItemCard({ id: '11111111-2222-4333-8444-555555550001' })];
    const refreshed = [
      makeItemCard({ id: '11111111-2222-4333-8444-555555550001' }),
      makeItemCard({ id: '11111111-2222-4333-8444-555555550002', title: 'A freshly imported memory' }),
    ];
    const loadMoreFetch = deferred<TimelinePageDTO>();
    const getTimeline = vi
      .fn<KawsayAPI['getTimeline']>()
      .mockResolvedValueOnce(page({ items: firstPage, nextCursor: 'cursor-2' }))
      .mockReturnValueOnce(loadMoreFetch.promise)
      .mockResolvedValueOnce(page({ items: refreshed, nextCursor: null }));
    const api = makeFakeApi({ getTimeline });
    const { result, rerender } = renderHook(({ dataVersion }) => useTimeline({ dataVersion }), {
      wrapper: wrapper(api),
      initialProps: { dataVersion: 0 },
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.hasMore).toBe(true);

    // A background loadMore is kicked off and held in flight by the deferred promise.
    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => expect(getTimeline).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe('loadingMore');

    // Import completes: dataVersion bumps while the loadMore is still pending.
    rerender({ dataVersion: 1 });

    // Settle the in-flight loadMore. Its (now superseded) page must NOT be appended
    // and must NOT clobber the refetch's fresh page-1 result.
    await act(async () => {
      loadMoreFetch.resolve(page({ items: [makeItemCard({ id: 'stale-should-not-appear' })], nextCursor: null }));
      await loadMoreFetch.promise;
    });

    await waitFor(() => expect(getTimeline).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(result.current.items.map((i) => i.id)).toEqual([
        '11111111-2222-4333-8444-555555550001',
        '11111111-2222-4333-8444-555555550002',
      ]),
    );
    expect(result.current.items.some((i) => i.id === 'stale-should-not-appear')).toBe(false);
  });

  it('tolerates a missing bridge (browser preview) without throwing or fetching', () => {
    const { result } = renderHook(() => useTimeline(), { wrapper: wrapper(undefined) });
    expect(result.current.status).toBe('unavailable');
    expect(result.current.items).toEqual([]);
    expect(result.current.hasMore).toBe(false);
    // No throw when the inert actions are invoked.
    act(() => {
      result.current.loadMore();
      result.current.reload();
    });
    expect(result.current.status).toBe('unavailable');
  });
});
