import { describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { useImport } from '@renderer/lib/use-import';
import { FAKE_JOB_ID, makeFakeApi, makeImportSummary, makeProgressEvent } from './support/fake-api';
import type { FakeApi } from './support/fake-api';

function wrapper(api?: FakeApi) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <KawsayApiProvider api={api}>{children}</KawsayApiProvider>;
  };
}

describe('useImport', () => {
  it('starts an import through the typed api and tracks the job id', async () => {
    const api = makeFakeApi();
    const { result } = renderHook(() => useImport(), { wrapper: wrapper(api) });

    await act(async () => {
      await result.current.start({ sourceType: 'whatsapp', inputPath: '/exports/chat.zip' });
    });

    expect(api.startImport).toHaveBeenCalledWith({
      sourceType: 'whatsapp',
      inputPath: '/exports/chat.zip',
    });
    expect(result.current.jobId).toBe(FAKE_JOB_ID);
    expect(result.current.status).toBe('running');
  });

  it('updates the running tally from progress events for this job', async () => {
    const api = makeFakeApi();
    const { result } = renderHook(() => useImport(), { wrapper: wrapper(api) });
    await act(async () => {
      await result.current.start({ sourceType: 'whatsapp', inputPath: '/c.zip' });
    });

    act(() => {
      api.emitProgress(
        makeProgressEvent({ phase: 'parse', processed: 84, total: 200, message: 'Reading messages…' }),
      );
    });

    expect(result.current.processed).toBe(84);
    expect(result.current.total).toBe(200);
    expect(result.current.message).toBe('Reading messages…');
    expect(result.current.phase).toBe('parse');
  });

  it('replays progress that arrives before startImport resolves with the job id (#97)', async () => {
    const startImport = vi.fn(async () => {
      api.emitProgress(
        makeProgressEvent({
          phase: 'parse',
          processed: 12,
          total: 48,
          message: 'Reading the archive…',
        }),
      );
      return { jobId: FAKE_JOB_ID };
    });
    const api = makeFakeApi({ startImport });
    const { result } = renderHook(() => useImport(), { wrapper: wrapper(api) });

    await act(async () => {
      await result.current.start({ sourceType: 'whatsapp', inputPath: '/c.zip' });
    });

    expect(result.current.status).toBe('running');
    expect(result.current.jobId).toBe(FAKE_JOB_ID);
    expect(result.current.processed).toBe(12);
    expect(result.current.total).toBe(48);
    expect(result.current.message).toBe('Reading the archive…');
  });

  it('ignores progress events belonging to a different job', async () => {
    const api = makeFakeApi();
    const { result } = renderHook(() => useImport(), { wrapper: wrapper(api) });
    await act(async () => {
      await result.current.start({ sourceType: 'folder', inputPath: '/photos' });
    });

    act(() => {
      api.emitProgress(
        makeProgressEvent({ jobId: '00000000-0000-0000-0000-000000000000', processed: 999 }),
      );
    });

    expect(result.current.processed).toBe(0);
  });

  it('completes when the terminal event carries a summary', async () => {
    const api = makeFakeApi();
    const summary = makeImportSummary({ occurrencesAdded: 347, skipped: [] });
    const { result } = renderHook(() => useImport(), { wrapper: wrapper(api) });
    await act(async () => {
      await result.current.start({ sourceType: 'whatsapp', inputPath: '/c.zip' });
    });

    act(() => {
      api.emitProgress(makeProgressEvent({ phase: 'done', summary }));
    });

    expect(result.current.status).toBe('complete');
    expect(result.current.summary).toEqual(summary);
  });

  it('reports a cancelled import when the summary is flagged cancelled', async () => {
    const api = makeFakeApi();
    const { result } = renderHook(() => useImport(), { wrapper: wrapper(api) });
    await act(async () => {
      await result.current.start({ sourceType: 'whatsapp', inputPath: '/c.zip' });
    });

    act(() => {
      api.emitProgress(
        makeProgressEvent({ phase: 'done', summary: makeImportSummary({ cancelled: true }) }),
      );
    });

    expect(result.current.status).toBe('cancelled');
  });

  it('enters an error status when the terminal event carries an error', async () => {
    const api = makeFakeApi();
    const { result } = renderHook(() => useImport(), { wrapper: wrapper(api) });
    await act(async () => {
      await result.current.start({ sourceType: 'whatsapp', inputPath: '/c.zip' });
    });

    act(() => {
      api.emitProgress(makeProgressEvent({ phase: 'done', error: 'ERR_ARCHIVE_UNSAFE_PATH' }));
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).not.toBeNull();
  });

  it('cancel() asks the typed api to cancel the in-flight job', async () => {
    const api = makeFakeApi();
    const { result } = renderHook(() => useImport(), { wrapper: wrapper(api) });
    await act(async () => {
      await result.current.start({ sourceType: 'whatsapp', inputPath: '/c.zip' });
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(api.cancelImport).toHaveBeenCalledWith({ jobId: FAKE_JOB_ID });
  });

  it('leaves the Stopping state when cancelImport rejects and no terminal event arrives (#96)', async () => {
    const api = makeFakeApi({ cancelImport: vi.fn(() => Promise.reject(new Error('worker unavailable'))) });
    const { result } = renderHook(() => useImport(), { wrapper: wrapper(api) });
    await act(async () => {
      await result.current.start({ sourceType: 'whatsapp', inputPath: '/c.zip' });
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatch(/stop|cancel/i);
  });

  it('unsubscribes from the progress stream on unmount', async () => {
    const api = makeFakeApi();
    const { result, unmount } = renderHook(() => useImport(), { wrapper: wrapper(api) });
    await act(async () => {
      await result.current.start({ sourceType: 'whatsapp', inputPath: '/c.zip' });
    });
    expect(api.subscriberCount()).toBeGreaterThan(0);
    unmount();
    expect(api.subscriberCount()).toBe(0);
  });

  it('does not throw when the api bridge is absent', async () => {
    const { result } = renderHook(() => useImport(), { wrapper: wrapper(undefined) });
    await act(async () => {
      await result.current.start({ sourceType: 'whatsapp', inputPath: '/c.zip' });
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
  });
});
