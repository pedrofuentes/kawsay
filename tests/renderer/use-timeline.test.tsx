import { describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { useTimeline } from '@renderer/lib/use-timeline';
import type { TimelinePageDTO } from '@shared/kawsay-api';
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

describe('useTimeline', () => {
  it('loads the first page through the typed bridge on mount', async () => {
    const items = [makeItemCard({ id: '11111111-2222-4333-8444-555555550001' })];
    const getTimeline = vi.fn(() => Promise.resolve(page({ items, nextCursor: null })));
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
