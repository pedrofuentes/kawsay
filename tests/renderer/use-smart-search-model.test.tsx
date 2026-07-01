import { describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { useSmartSearchModel } from '@renderer/lib/use-smart-search-model';
import { makeFakeApi, makeModelDownloadProgressEvent } from './support/fake-api';
import type { FakeApi } from './support/fake-api';

function wrapper(api?: FakeApi) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <KawsayApiProvider api={api}>{children}</KawsayApiProvider>;
  };
}

const downloadStarted = () => Promise.resolve({ outcome: 'download-started' as const });
const alreadyPresent = () => Promise.resolve({ outcome: 'already-present' as const });
const unsupported = () => Promise.resolve({ outcome: 'unsupported-platform' as const });

const status = (over: Partial<{ optedIn: boolean; modelReady: boolean; offered: boolean }> = {}) =>
  vi.fn(() => Promise.resolve({ optedIn: false, modelReady: false, offered: false, ...over }));

describe('useSmartSearchModel', () => {
  it('never starts a download on mount — no byte moves without an explicit opt-in (M4-1b)', async () => {
    const api = makeFakeApi({ enableSmartSearch: vi.fn(downloadStarted) });
    const { result } = renderHook(() => useSmartSearchModel(), { wrapper: wrapper(api) });

    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(api.enableSmartSearch).not.toHaveBeenCalled();
    expect(result.current.modelReady).toBe(false);
  });

  it('reflects offered / optedIn / modelReady from getSmartSearchStatus, without downloading', async () => {
    const api = makeFakeApi({
      getSmartSearchStatus: status({ optedIn: true, modelReady: true, offered: true }),
      enableSmartSearch: vi.fn(downloadStarted),
    });
    const { result } = renderHook(() => useSmartSearchModel(), { wrapper: wrapper(api) });

    await waitFor(() => expect(result.current.modelReady).toBe(true));
    expect(result.current.status).toBe('ready');
    expect(result.current.optedIn).toBe(true);
    expect(result.current.offered).toBe(true);
    expect(api.enableSmartSearch).not.toHaveBeenCalled();
  });

  it('surfaces offered=false so the opt-in card can stay hidden pre-publish (the gate)', async () => {
    const api = makeFakeApi({ getSmartSearchStatus: status({ offered: false }) });
    const { result } = renderHook(() => useSmartSearchModel(), { wrapper: wrapper(api) });

    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.offered).toBe(false);
  });

  it('stays calmly not-ready (no crash) when the status probe fails, and hides the card', async () => {
    const api = makeFakeApi({
      getSmartSearchStatus: vi.fn(() => Promise.reject(new Error('status failed'))),
    });
    const { result } = renderHook(() => useSmartSearchModel(), { wrapper: wrapper(api) });

    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.modelReady).toBe(false);
    // A failed probe must not accidentally reveal the surface.
    expect(result.current.offered).toBe(false);
    expect(api.enableSmartSearch).not.toHaveBeenCalled();
  });

  it('self-heals after a status-probe rejection — a later enable() still downloads to ready', async () => {
    const api = makeFakeApi({
      getSmartSearchStatus: vi.fn(() => Promise.reject(new Error('status check failed'))),
      enableSmartSearch: vi.fn(downloadStarted),
    });
    const { result } = renderHook(() => useSmartSearchModel(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      await result.current.enable();
    });
    act(() => {
      api.emitSmartSearchModelDownloadProgress(makeModelDownloadProgressEvent({ phase: 'done' }));
    });

    expect(result.current.modelReady).toBe(true);
    expect(result.current.status).toBe('ready');
  });

  it('enable() starts the download exactly once through the typed api', async () => {
    const api = makeFakeApi({
      getSmartSearchStatus: status({ offered: true }),
      enableSmartSearch: vi.fn(downloadStarted),
    });
    const { result } = renderHook(() => useSmartSearchModel(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      await result.current.enable();
    });

    expect(api.enableSmartSearch).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('downloading');
  });

  it('tracks streamed byte progress while downloading', async () => {
    const api = makeFakeApi({
      getSmartSearchStatus: status({ offered: true }),
      enableSmartSearch: vi.fn(downloadStarted),
    });
    const { result } = renderHook(() => useSmartSearchModel(), { wrapper: wrapper(api) });
    await act(async () => {
      await result.current.enable();
    });

    act(() => {
      api.emitSmartSearchModelDownloadProgress(
        makeModelDownloadProgressEvent({
          phase: 'downloading',
          bytesDownloaded: 65_011_712,
          totalBytes: 130_023_424,
        }),
      );
    });

    expect(result.current.bytesDownloaded).toBe(65_011_712);
    expect(result.current.totalBytes).toBe(130_023_424);
    expect(result.current.phase).toBe('downloading');
    expect(result.current.status).toBe('downloading');
  });

  it('becomes ready when the stream reaches the done phase', async () => {
    const api = makeFakeApi({
      getSmartSearchStatus: status({ offered: true }),
      enableSmartSearch: vi.fn(downloadStarted),
    });
    const { result } = renderHook(() => useSmartSearchModel(), { wrapper: wrapper(api) });
    await act(async () => {
      await result.current.enable();
    });

    act(() => {
      api.emitSmartSearchModelDownloadProgress(makeModelDownloadProgressEvent({ phase: 'done' }));
    });

    expect(result.current.modelReady).toBe(true);
    expect(result.current.status).toBe('ready');
  });

  it('is immediately ready when enable() finds the model already present', async () => {
    const api = makeFakeApi({
      getSmartSearchStatus: status({ offered: true }),
      enableSmartSearch: vi.fn(alreadyPresent),
    });
    const { result } = renderHook(() => useSmartSearchModel(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      await result.current.enable();
    });

    expect(result.current.modelReady).toBe(true);
    expect(result.current.status).toBe('ready');
  });

  it('enters a calm, non-retryable unsupported state when the platform cannot install it', async () => {
    const api = makeFakeApi({
      getSmartSearchStatus: status({ offered: true }),
      enableSmartSearch: vi.fn(unsupported),
    });
    const { result } = renderHook(() => useSmartSearchModel(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      await result.current.enable();
    });

    expect(result.current.status).toBe('unsupported');
    expect(result.current.modelReady).toBe(false);
  });

  it('enters a gentle, typed error state when the stream reports a failure', async () => {
    const api = makeFakeApi({
      getSmartSearchStatus: status({ offered: true }),
      enableSmartSearch: vi.fn(downloadStarted),
    });
    const { result } = renderHook(() => useSmartSearchModel(), { wrapper: wrapper(api) });
    await act(async () => {
      await result.current.enable();
    });

    act(() => {
      api.emitSmartSearchModelDownloadProgress(
        makeModelDownloadProgressEvent({
          phase: 'error',
          bytesDownloaded: 12,
          error: { kind: 'network', message: 'getaddrinfo ENOTFOUND raw.host', retryable: true },
        }),
      );
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toEqual({ kind: 'network', retryable: true });
  });

  it('retry() asks the api to download again and returns to a downloading state', async () => {
    const enable = vi.fn(downloadStarted);
    const api = makeFakeApi({
      getSmartSearchStatus: status({ offered: true }),
      enableSmartSearch: enable,
    });
    const { result } = renderHook(() => useSmartSearchModel(), { wrapper: wrapper(api) });
    await act(async () => {
      await result.current.enable();
    });
    act(() => {
      api.emitSmartSearchModelDownloadProgress(
        makeModelDownloadProgressEvent({
          phase: 'error',
          error: { kind: 'network', message: 'offline', retryable: true },
        }),
      );
    });
    expect(result.current.status).toBe('error');

    await act(async () => {
      await result.current.retry();
    });

    expect(enable).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('downloading');
    expect(result.current.error).toBeNull();
  });

  it('surfaces a gentle error (never a crash) when enable() rejects', async () => {
    const api = makeFakeApi({
      getSmartSearchStatus: status({ offered: true }),
      enableSmartSearch: vi.fn(() => Promise.reject(new Error('boom'))),
    });
    const { result } = renderHook(() => useSmartSearchModel(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      await result.current.enable();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).not.toBeNull();
  });

  it('unsubscribes from the smart-search progress stream on unmount', async () => {
    const api = makeFakeApi();
    const { unmount } = renderHook(() => useSmartSearchModel(), { wrapper: wrapper(api) });
    await waitFor(() => expect(api.smartSearchModelSubscriberCount()).toBeGreaterThan(0));

    unmount();

    expect(api.smartSearchModelSubscriberCount()).toBe(0);
  });

  it('does not throw when the api bridge is absent (browser preview)', async () => {
    const { result } = renderHook(() => useSmartSearchModel(), { wrapper: wrapper(undefined) });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      await result.current.enable();
    });

    expect(result.current.status).toBe('error');
  });
});
