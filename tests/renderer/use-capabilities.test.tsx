import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { useCapabilities } from '@renderer/lib/use-capabilities';
import { makeFakeApi } from './support/fake-api';
import type { FakeApi } from './support/fake-api';

function wrapper(api?: FakeApi) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <KawsayApiProvider api={api}>{children}</KawsayApiProvider>;
  };
}

const HEALTHY = {
  ffmpeg: true,
  ffprobe: true,
  clusterWorker: true,
  embedder: true,
  gazetteer: true,
} as const;

describe('useCapabilities', () => {
  it('resolves the aggregate capability report from getCapabilities on mount', async () => {
    const degraded = { ...HEALTHY, ffmpeg: false, ffprobe: false };
    const api = makeFakeApi({ getCapabilities: vi.fn(() => Promise.resolve(degraded)) });
    const { result } = renderHook(() => useCapabilities(), { wrapper: wrapper(api) });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.capabilities).toEqual(degraded);
    expect(api.getCapabilities).toHaveBeenCalledTimes(1);
  });

  it('stays calm (null capabilities, never throws) when the probe rejects', async () => {
    const api = makeFakeApi({
      getCapabilities: vi.fn(() => Promise.reject(new Error('probe failed'))),
    });
    const { result } = renderHook(() => useCapabilities(), { wrapper: wrapper(api) });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.capabilities).toBeNull();
  });

  it('reports null capabilities when there is no bridge (api undefined)', async () => {
    const { result } = renderHook(() => useCapabilities(), { wrapper: wrapper(undefined) });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.capabilities).toBeNull();
  });
});
