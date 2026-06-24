import { describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { LibraryProvider, useLibrary } from '@renderer/lib/library';
import { makeFakeApi, makeLibrarySummary } from './support/fake-api';
import type { FakeApi } from './support/fake-api';

function wrapper(api?: FakeApi) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <KawsayApiProvider api={api}>
        <LibraryProvider>{children}</LibraryProvider>
      </KawsayApiProvider>
    );
  };
}

describe('useLibrary', () => {
  it('starts with no open library and an idle status', () => {
    const { result } = renderHook(() => useLibrary(), { wrapper: wrapper(makeFakeApi()) });
    expect(result.current.library).toBeNull();
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('createLibrary calls the typed api and stores the returned library', async () => {
    const summary = makeLibrarySummary({ name: 'Elena', root: '/lib/elena' });
    const api = makeFakeApi({ createLibrary: vi.fn(() => Promise.resolve(summary)) });
    const { result } = renderHook(() => useLibrary(), { wrapper: wrapper(api) });

    let returned: unknown;
    await act(async () => {
      returned = await result.current.createLibrary({ path: '/lib/elena', personName: 'Elena' });
    });

    expect(api.createLibrary).toHaveBeenCalledWith({ path: '/lib/elena', personName: 'Elena' });
    expect(returned).toEqual(summary);
    expect(result.current.library).toEqual(summary);
    expect(result.current.status).toBe('idle');
  });

  it('openLibrary calls the typed api and stores the returned library', async () => {
    const summary = makeLibrarySummary({ name: 'Abuela', root: '/lib/abuela' });
    const api = makeFakeApi({ openLibrary: vi.fn(() => Promise.resolve(summary)) });
    const { result } = renderHook(() => useLibrary(), { wrapper: wrapper(api) });

    await act(async () => {
      await result.current.openLibrary({ path: '/lib/abuela' });
    });

    expect(api.openLibrary).toHaveBeenCalledWith({ path: '/lib/abuela' });
    expect(result.current.library).toEqual(summary);
  });

  it('exposes a loading status while a create is in flight', async () => {
    let resolve!: (value: ReturnType<typeof makeLibrarySummary>) => void;
    const pending = new Promise<ReturnType<typeof makeLibrarySummary>>((r) => {
      resolve = r;
    });
    const api = makeFakeApi({ createLibrary: vi.fn(() => pending) });
    const { result } = renderHook(() => useLibrary(), { wrapper: wrapper(api) });

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.createLibrary({ path: '/lib/x' });
    });
    await waitFor(() => expect(result.current.status).toBe('loading'));

    await act(async () => {
      resolve(makeLibrarySummary());
      await done;
    });
    expect(result.current.status).toBe('idle');
  });

  it('surfaces an error status (not a raw code) when create fails, keeping no library open', async () => {
    const api = makeFakeApi({
      createLibrary: vi.fn(() => Promise.reject(new Error('EACCES: permission denied, mkdir'))),
    });
    const { result } = renderHook(() => useLibrary(), { wrapper: wrapper(api) });

    let returned: unknown = 'unset';
    await act(async () => {
      returned = await result.current.createLibrary({ path: '/nope' });
    });

    expect(returned).toBeNull();
    expect(result.current.status).toBe('error');
    expect(result.current.error).not.toBeNull();
    expect(result.current.library).toBeNull();
  });

  it('does not throw when the api bridge is absent (browser preview)', async () => {
    const { result } = renderHook(() => useLibrary(), { wrapper: wrapper(undefined) });
    let returned: unknown = 'unset';
    await act(async () => {
      returned = await result.current.createLibrary({ path: '/lib/x' });
    });
    expect(returned).toBeNull();
    expect(result.current.status).toBe('error');
  });

  it('throws a clear error when used outside the provider', () => {
    expect(() => renderHook(() => useLibrary())).toThrow(/LibraryProvider/);
  });
});
