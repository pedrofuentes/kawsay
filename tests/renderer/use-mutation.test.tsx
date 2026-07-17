// Direct tests for the shared `useMutation` primitive (#486) — the imperative
// sibling of `useQuery`. Where `useQuery` guards a fetch-on-key READ, this guards
// an imperative WRITE: a `mutate` captures a monotonic generation at call time and
// its outcome commits ONLY if that generation is still current, the hook is still
// mounted, AND the hook is still enabled. So the LATEST invocation wins — an
// earlier action that resolves after a newer one, a settle after unmount, or a
// settle after the feature was disabled are all dropped. This is exactly the
// hand-rolled `runAction` guard `useSuggestions` used to carry for the #407
// spurious-notice race, proven here once for all mutation callers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useMutation } from '@renderer/lib/use-mutation';

/** A hand-rolled deferred so a test can settle a mutation on demand. */
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useMutation — idle → pending → success', () => {
  it('starts idle, goes pending on mutate, and lands on success (firing onSuccess)', async () => {
    const onSuccess = vi.fn();
    const mutationFn = vi.fn((n: number) => Promise.resolve(n * 2));
    const { result } = renderHook(() => useMutation({ mutationFn, onSuccess }));

    expect(result.current.status).toBe('idle');
    expect(result.current.isPending).toBe(false);

    act(() => result.current.mutate(21));
    expect(result.current.status).toBe('pending');
    expect(result.current.isPending).toBe(true);

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.error).toBeUndefined();
    expect(onSuccess).toHaveBeenCalledWith(42, 21);
    expect(mutationFn).toHaveBeenCalledTimes(1);
  });
});

describe('useMutation — error surfacing (raw rejection preserved)', () => {
  it('lands on error, exposes the RAW rejection, and fires onError', async () => {
    const cause = new Error('write failed');
    const onError = vi.fn();
    const mutationFn = vi.fn(() => Promise.reject(cause));
    const { result } = renderHook(() => useMutation<void, unknown>({ mutationFn, onError }));

    act(() => result.current.mutate(undefined));
    await waitFor(() => expect(result.current.status).toBe('error'));
    // The owning hook maps the cause to copy — surface it verbatim.
    expect(result.current.error).toBe(cause);
    expect(onError).toHaveBeenCalledWith(cause, undefined);
  });
});

describe('useMutation — latest-wins guard (the #407 hazard)', () => {
  it('an earlier mutation resolving AFTER a newer one must NOT clobber the newer outcome', async () => {
    const slowEarlier = deferred<string>();
    const fastLater = deferred<string>();
    const mutationFn = vi
      .fn<(v: string) => Promise<string>>()
      .mockReturnValueOnce(slowEarlier.promise)
      .mockReturnValueOnce(fastLater.promise);
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useMutation({ mutationFn, onSuccess }));

    // Two mutations in flight: the earlier is slow, the later resolves first.
    act(() => result.current.mutate('earlier'));
    act(() => result.current.mutate('later'));
    expect(mutationFn).toHaveBeenCalledTimes(2);

    await act(async () => {
      fastLater.resolve('LATER-wins');
      await fastLater.promise;
    });
    expect(result.current.status).toBe('success');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenLastCalledWith('LATER-wins', 'later');

    // The earlier, superseded mutation resolves last — its outcome is DROPPED and
    // must never re-fire onSuccess or regress the committed newer result.
    await act(async () => {
      slowEarlier.resolve('EARLIER-stale');
      await slowEarlier.promise;
      await Promise.resolve();
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('success');
  });

  it('a stale REJECTION arriving after a newer success must not surface an error', async () => {
    const slowEarlier = deferred<string>();
    const fastLater = deferred<string>();
    const mutationFn = vi
      .fn<(v: string) => Promise<string>>()
      .mockReturnValueOnce(slowEarlier.promise)
      .mockReturnValueOnce(fastLater.promise);
    const onError = vi.fn();
    const { result } = renderHook(() => useMutation({ mutationFn, onError }));

    act(() => result.current.mutate('earlier'));
    act(() => result.current.mutate('later'));

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
    // The superseded rejection is dropped — no spurious error state, no onError.
    expect(result.current.status).toBe('success');
    expect(result.current.error).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('useMutation — unmounted guard', () => {
  it('does not commit (or throw) when a mutation resolves after unmount', async () => {
    const pending = deferred<string>();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onSuccess = vi.fn();
    const mutationFn = vi.fn(() => pending.promise);
    const { result, unmount } = renderHook(() => useMutation({ mutationFn, onSuccess }));

    act(() => result.current.mutate(undefined));
    expect(result.current.isPending).toBe(true);

    unmount();
    await act(async () => {
      pending.resolve('after-unmount');
      await pending.promise;
      await Promise.resolve();
    });
    expect(onSuccess).not.toHaveBeenCalled();
    const warned = errorSpy.mock.calls.some(
      (args) => typeof args[0] === 'string' && /unmounted/i.test(args[0]),
    );
    expect(warned).toBe(false);
  });
});

describe('useMutation — disabled/enabled gate', () => {
  it('drops a mutation that rejects AFTER the hook was disabled (no error surfaces)', async () => {
    const pending = deferred<string>();
    const onError = vi.fn();
    const mutationFn = vi.fn(() => pending.promise);
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useMutation({ mutationFn, onError, enabled }),
      { initialProps: { enabled: true } },
    );

    // A mutation is in flight when the feature is toggled off.
    act(() => result.current.mutate(undefined));
    rerender({ enabled: false });

    await act(async () => {
      pending.reject(new Error('post-disable rejection'));
      await pending.promise.catch(() => undefined);
      await Promise.resolve();
    });
    // The post-disable rejection is ignored — a disabled hook never surfaces it.
    expect(result.current.status).not.toBe('error');
    expect(onError).not.toHaveBeenCalled();
  });

  it('disabling clears a previously surfaced error back to idle', async () => {
    const mutationFn = vi.fn(() => Promise.reject(new Error('boom')));
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useMutation({ mutationFn, enabled }),
      { initialProps: { enabled: true } },
    );

    act(() => result.current.mutate(undefined));
    await waitFor(() => expect(result.current.status).toBe('error'));

    rerender({ enabled: false });
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeUndefined();
  });

  it('does not run the mutationFn while disabled', async () => {
    const mutationFn = vi.fn(() => Promise.resolve('x'));
    const { result } = renderHook(() => useMutation({ mutationFn, enabled: false }));

    act(() => result.current.mutate(undefined));
    await Promise.resolve();
    expect(mutationFn).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });
});
