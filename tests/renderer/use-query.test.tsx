// Direct tests for the shared `useQuery` data-fetch primitive (#443). This is the
// single race-guarded, keyed, stale-while-revalidate read layer the renderer hooks
// migrate onto, so the bespoke monotonic-request-id / inFlight-active-flag /
// generation guards each hand-rolled can collapse into ONE audited place. The
// load-bearing guard these pin is the out-of-order race: an EARLIER-issued fetch
// that resolves AFTER a later one must NOT clobber the newer result — the exact
// hazard the #360/#383/#407 hooks defend against, proven here once for all of them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { resetQueryCache, useQuery } from '@renderer/lib/use-query';

/** A hand-rolled deferred so a test can settle a fetch on demand. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetQueryCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useQuery — loading → success', () => {
  it('starts in loading and lands on the resolved data', async () => {
    const fetcher = vi.fn(() => Promise.resolve('hello'));
    const { result } = renderHook(() => useQuery({ key: 'k', fetcher }));

    expect(result.current.status).toBe('loading');
    expect(result.current.data).toBeUndefined();
    expect(result.current.isFetching).toBe(true);

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.data).toBe('hello');
    expect(result.current.isFetching).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('useQuery — error surfacing (raw rejection preserved)', () => {
  it('lands on error and exposes the RAW rejection (never swallowed/remapped)', async () => {
    const cause = new Error('disk hiccup');
    const fetcher = vi.fn(() => Promise.reject(cause));
    const { result } = renderHook(() => useQuery({ key: 'k', fetcher }));

    await waitFor(() => expect(result.current.status).toBe('error'));
    // The hook that owns error COPY (e.g. ipcErrorCopy) needs the raw cause — the
    // utility must surface it verbatim rather than mapping or dropping it.
    expect(result.current.error).toBe(cause);
    expect(result.current.data).toBeUndefined();
    expect(result.current.isFetching).toBe(false);
  });
});

describe('useQuery — disabled/idle', () => {
  it('does not fetch while key is null and stays idle', async () => {
    const fetcher = vi.fn(() => Promise.resolve('x'));
    const { result } = renderHook(() => useQuery({ key: null, fetcher }));

    expect(result.current.status).toBe('idle');
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it('does not fetch while enabled is false', async () => {
    const fetcher = vi.fn(() => Promise.resolve('x'));
    const { result } = renderHook(() => useQuery({ key: 'k', fetcher, enabled: false }));

    expect(result.current.status).toBe('idle');
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('useQuery — refetch', () => {
  it('re-runs the fetcher and commits the fresh result', async () => {
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second');
    const { result } = renderHook(() => useQuery({ key: 'k', fetcher }));
    await waitFor(() => expect(result.current.data).toBe('first'));

    await act(async () => {
      result.current.refetch();
    });
    await waitFor(() => expect(result.current.data).toBe('second'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refetch({ showLoading: true }) returns status to loading during the re-fetch', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useQuery({ key: 'k', fetcher }));
    await act(async () => {
      first.resolve('first');
      await first.promise;
    });
    expect(result.current.status).toBe('success');

    act(() => result.current.refetch({ showLoading: true }));
    expect(result.current.status).toBe('loading');

    await act(async () => {
      second.resolve('second');
      await second.promise;
    });
    expect(result.current.status).toBe('success');
    expect(result.current.data).toBe('second');
  });
});

describe('useQuery — refetch on key change', () => {
  it('fetches again when the key changes and shows the new key data', async () => {
    const fetcher = vi.fn((key: string) => Promise.resolve(`data-for-${key}`));
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useQuery({ key, fetcher: () => fetcher(key) }),
      { initialProps: { key: 'a' } },
    );
    await waitFor(() => expect(result.current.data).toBe('data-for-a'));

    rerender({ key: 'b' });
    await waitFor(() => expect(result.current.data).toBe('data-for-b'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('useQuery — out-of-order race guard (the #360/#383/#407 hazard)', () => {
  it('an earlier-issued fetch resolving AFTER a later one must NOT clobber the newer result', async () => {
    const slowEarlier = deferred<string>();
    const fastLater = deferred<string>();
    // First fetch (earlier) is slow; the refetch (later) resolves first.
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(slowEarlier.promise)
      .mockReturnValueOnce(fastLater.promise);

    const { result } = renderHook(() => useQuery({ key: 'k', fetcher }));
    expect(result.current.isFetching).toBe(true);

    // Issue the later fetch while the earlier one is still in flight.
    act(() => result.current.refetch());
    expect(fetcher).toHaveBeenCalledTimes(2);

    // The LATER fetch resolves first — its result is committed.
    await act(async () => {
      fastLater.resolve('LATER-wins');
      await fastLater.promise;
    });
    expect(result.current.data).toBe('LATER-wins');

    // The EARLIER fetch resolves last — it is superseded and MUST be dropped, never
    // regressing the committed newer result.
    await act(async () => {
      slowEarlier.resolve('EARLIER-stale');
      await slowEarlier.promise;
      await Promise.resolve();
    });
    expect(result.current.data).toBe('LATER-wins');
    expect(result.current.data).not.toBe('EARLIER-stale');
  });

  it('a stale REJECTION arriving after a newer success must not surface an error', async () => {
    const slowEarlier = deferred<string>();
    const fastLater = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(slowEarlier.promise)
      .mockReturnValueOnce(fastLater.promise);

    const { result } = renderHook(() => useQuery({ key: 'k', fetcher }));
    act(() => result.current.refetch());

    await act(async () => {
      fastLater.resolve('LATER-wins');
      await fastLater.promise;
    });
    expect(result.current.status).toBe('success');

    await act(async () => {
      slowEarlier.reject(new Error('stale failure'));
      await slowEarlier.promise.catch(() => undefined);
      await Promise.resolve();
    });
    // The superseded rejection is dropped — no spurious error state.
    expect(result.current.status).toBe('success');
    expect(result.current.data).toBe('LATER-wins');
    expect(result.current.error).toBeUndefined();
  });
});

describe('useQuery — unmounted guard', () => {
  it('does not commit (or throw) when the fetch resolves after unmount', async () => {
    const pending = deferred<string>();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetcher = vi.fn(() => pending.promise);
    const { result, unmount } = renderHook(() => useQuery({ key: 'k', fetcher }));
    expect(result.current.isFetching).toBe(true);

    unmount();
    await act(async () => {
      pending.resolve('after-unmount');
      await pending.promise;
      await Promise.resolve();
    });
    // No "setState on unmounted component" warning was emitted.
    const warned = errorSpy.mock.calls.some(
      (args) => typeof args[0] === 'string' && /unmounted/i.test(args[0]),
    );
    expect(warned).toBe(false);
  });
});

describe('useQuery — stale-while-revalidate cache (opt-in)', () => {
  it('a second mount for a cached key shows the cached value immediately, then revalidates', async () => {
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('v1')
      .mockResolvedValueOnce('v2');
    const first = renderHook(() => useQuery({ key: 'shared', fetcher, cache: true }));
    await waitFor(() => expect(first.result.current.data).toBe('v1'));
    first.unmount();

    // A fresh mount for the same key: cached value is shown WITHOUT a loading flash,
    // and a background revalidation runs.
    const second = renderHook(() => useQuery({ key: 'shared', fetcher, cache: true }));
    expect(second.result.current.data).toBe('v1');
    expect(second.result.current.status).toBe('success');

    await waitFor(() => expect(second.result.current.data).toBe('v2'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('without cache, a second mount starts from loading (no cross-mount retention)', async () => {
    const fetcher = vi.fn(() => Promise.resolve('v'));
    const first = renderHook(() => useQuery({ key: 'k', fetcher }));
    await waitFor(() => expect(first.result.current.data).toBe('v'));
    first.unmount();

    const second = renderHook(() => useQuery({ key: 'k', fetcher }));
    expect(second.result.current.status).toBe('loading');
    expect(second.result.current.data).toBeUndefined();
  });

  it('resetQueryCache clears retained data so tests never leak across each other', async () => {
    const fetcher = vi.fn(() => Promise.resolve('cached'));
    const first = renderHook(() => useQuery({ key: 'k', fetcher, cache: true }));
    await waitFor(() => expect(first.result.current.data).toBe('cached'));
    first.unmount();

    resetQueryCache();

    const second = renderHook(() => useQuery({ key: 'k', fetcher, cache: true }));
    // After a reset the cache is empty again — no stale value from the prior mount.
    expect(second.result.current.data).toBeUndefined();
    expect(second.result.current.status).toBe('loading');
  });
});

describe('useQuery — showLoading wins over the stale cache (hard refresh)', () => {
  it('cache:true + a populated cache + refetch({ showLoading }) still goes to loading, not a silent success', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useQuery({ key: 'k', fetcher, cache: true }));
    await act(async () => {
      first.resolve('v1');
      await first.promise;
    });
    // The cache is now populated with 'v1'.
    expect(result.current.status).toBe('success');
    expect(result.current.data).toBe('v1');

    // A hard refresh MUST show loading even though a cached value exists — a caller
    // that asks for showLoading (e.g. useCollections.reload) relies on it; the cache
    // must not silently suppress it into a background revalidation.
    act(() => result.current.refetch({ showLoading: true }));
    expect(result.current.status).toBe('loading');

    await act(async () => {
      second.resolve('v2');
      await second.promise;
    });
    expect(result.current.status).toBe('success');
    expect(result.current.data).toBe('v2');
  });
});

describe('useQuery — setData (imperative cache write for mutations)', () => {
  it('setData updates the visible data and the cache', async () => {
    const fetcher = vi.fn(() => Promise.resolve('server'));
    const { result } = renderHook(() => useQuery({ key: 'k', fetcher, cache: true }));
    await waitFor(() => expect(result.current.data).toBe('server'));

    act(() => result.current.setData('locally-updated'));
    expect(result.current.data).toBe('locally-updated');

    act(() => result.current.setData((prev) => `${prev ?? ''}!`));
    expect(result.current.data).toBe('locally-updated!');
  });
});
