import { describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { useModelDownload } from '@renderer/lib/use-model-download';
import { makeFakeApi, makeModelDownloadProgressEvent } from './support/fake-api';
import type { FakeApi } from './support/fake-api';

function wrapper(api?: FakeApi) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <KawsayApiProvider api={api}>{children}</KawsayApiProvider>;
  };
}

const started = () => Promise.resolve({ status: 'started' as const });

describe('useModelDownload', () => {
  it('never starts a download on mount — no byte moves without an explicit opt-in (AC-22)', async () => {
    const api = makeFakeApi();
    const { result } = renderHook(() => useModelDownload(), { wrapper: wrapper(api) });

    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(api.downloadTranscriptionModel).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
  });

  it('reflects an already-verified model from isTranscriptionModelReady, without downloading', async () => {
    const api = makeFakeApi({ isTranscriptionModelReady: vi.fn(() => Promise.resolve(true)) });
    const { result } = renderHook(() => useModelDownload(), { wrapper: wrapper(api) });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.status).toBe('ready');
    expect(api.downloadTranscriptionModel).not.toHaveBeenCalled();
  });

  it('enable() starts the download exactly once through the typed api', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { result } = renderHook(() => useModelDownload(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      await result.current.enable();
    });

    expect(api.downloadTranscriptionModel).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('downloading');
  });

  it('tracks streamed byte progress while downloading', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { result } = renderHook(() => useModelDownload(), { wrapper: wrapper(api) });
    await act(async () => {
      await result.current.enable();
    });

    act(() => {
      api.emitModelDownloadProgress(
        makeModelDownloadProgressEvent({
          phase: 'downloading',
          bytesDownloaded: 244_318_208,
          totalBytes: 488_636_416,
        }),
      );
    });

    expect(result.current.bytesDownloaded).toBe(244_318_208);
    expect(result.current.totalBytes).toBe(488_636_416);
    expect(result.current.phase).toBe('downloading');
    expect(result.current.status).toBe('downloading');
  });

  it('becomes ready when the stream reaches the done phase', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { result } = renderHook(() => useModelDownload(), { wrapper: wrapper(api) });
    await act(async () => {
      await result.current.enable();
    });

    act(() => {
      api.emitModelDownloadProgress(makeModelDownloadProgressEvent({ phase: 'done' }));
    });

    expect(result.current.ready).toBe(true);
    expect(result.current.status).toBe('ready');
  });

  it('is immediately ready when enable() finds the model already present', async () => {
    const api = makeFakeApi({
      downloadTranscriptionModel: vi.fn(() => Promise.resolve({ status: 'already-present' as const })),
    });
    const { result } = renderHook(() => useModelDownload(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      await result.current.enable();
    });

    expect(result.current.ready).toBe(true);
    expect(result.current.status).toBe('ready');
  });

  it('enters a gentle, typed error state when the stream reports a failure', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { result } = renderHook(() => useModelDownload(), { wrapper: wrapper(api) });
    await act(async () => {
      await result.current.enable();
    });

    act(() => {
      api.emitModelDownloadProgress(
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
    const download = vi.fn(started);
    const api = makeFakeApi({ downloadTranscriptionModel: download });
    const { result } = renderHook(() => useModelDownload(), { wrapper: wrapper(api) });
    await act(async () => {
      await result.current.enable();
    });
    act(() => {
      api.emitModelDownloadProgress(
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

    expect(download).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('downloading');
    expect(result.current.error).toBeNull();
  });

  it('surfaces a gentle error (never a crash) when enable() rejects', async () => {
    const api = makeFakeApi({
      downloadTranscriptionModel: vi.fn(() => Promise.reject(new Error('boom'))),
    });
    const { result } = renderHook(() => useModelDownload(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      await result.current.enable();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).not.toBeNull();
  });

  it('unsubscribes from the progress stream on unmount', async () => {
    const api = makeFakeApi();
    const { unmount } = renderHook(() => useModelDownload(), { wrapper: wrapper(api) });
    await waitFor(() => expect(api.modelSubscriberCount()).toBeGreaterThan(0));

    unmount();

    expect(api.modelSubscriberCount()).toBe(0);
  });

  it('does not throw when the api bridge is absent (browser preview)', async () => {
    const { result } = renderHook(() => useModelDownload(), { wrapper: wrapper(undefined) });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      await result.current.enable();
    });

    expect(result.current.status).toBe('error');
  });
});
