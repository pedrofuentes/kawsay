import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { KawsayApiProvider, useKawsayApi } from '@renderer/lib/kawsay-api';
import { makeFakeApi } from './support/fake-api';

describe('useKawsayApi', () => {
  it('returns the injected api', () => {
    const api = makeFakeApi();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <KawsayApiProvider api={api}>{children}</KawsayApiProvider>
    );
    const { result } = renderHook(() => useKawsayApi(), { wrapper });
    expect(result.current).toBe(api);
  });

  it('tolerates the absence of window.kawsayAPI (browser preview) by returning undefined', () => {
    // No provider, no window bridge: a plain browser preview must not crash.
    const original = (window as { kawsayAPI?: unknown }).kawsayAPI;
    delete (window as { kawsayAPI?: unknown }).kawsayAPI;
    try {
      const { result } = renderHook(() => useKawsayApi());
      expect(result.current).toBeUndefined();
    } finally {
      if (original !== undefined) (window as { kawsayAPI?: unknown }).kawsayAPI = original;
    }
  });

  it('falls back to window.kawsayAPI when no api prop is given', () => {
    const api = makeFakeApi();
    (window as { kawsayAPI?: unknown }).kawsayAPI = api;
    try {
      const wrapper = ({ children }: { children: ReactNode }) => (
        <KawsayApiProvider>{children}</KawsayApiProvider>
      );
      const { result } = renderHook(() => useKawsayApi(), { wrapper });
      expect(result.current).toBe(api);
    } finally {
      delete (window as { kawsayAPI?: unknown }).kawsayAPI;
    }
  });
});
