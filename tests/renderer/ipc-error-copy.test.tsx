import { describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { LibraryProvider, useLibrary } from '@renderer/lib/library';
import { ipcErrorCopy } from '@renderer/lib/ipc-error-copy';
import { IPC_ERROR_CODES, IpcError } from '@shared/ipc/error-envelope';
import { makeFakeApi } from './support/fake-api';
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

// A path + id an old-style raw error WOULD have leaked; the code-driven copy must
// contain neither.
const PII_PATH = '/Users/alice/Memories/private.sqlite';
const PII_ID = 'item-7f3c-secret';

describe('ipcErrorCopy (renderer maps codes → reverent copy, #440)', () => {
  it('maps a handler-fault code to calm, non-technical copy', () => {
    const copy = ipcErrorCopy(new IpcError(IPC_ERROR_CODES.HANDLER_FAULT, 'CatalogSessionError'));
    expect(copy).toMatch(/please try again/i);
    expect(copy).not.toMatch(/ERR_IPC|CatalogSessionError|Error:/);
  });

  it('never surfaces raw error text (there is none to surface)', () => {
    const copy = ipcErrorCopy(new IpcError(IPC_ERROR_CODES.HANDLER_FAULT, 'Error'));
    expect(copy).not.toContain(PII_PATH);
    expect(copy).not.toContain(PII_ID);
  });

  it('falls back to reverent copy for a non-IpcError (e.g. a missing bridge)', () => {
    expect(ipcErrorCopy(new Error(`boom ${PII_PATH}`))).not.toContain(PII_PATH);
    expect(ipcErrorCopy(new Error('boom'))).toMatch(/please try again/i);
  });
});

describe('useLibrary surfaces reverent copy from a rejected invoke (#440)', () => {
  it('shows code-mapped copy, NOT the raw main-side message, on failure', async () => {
    const api = makeFakeApi({
      openLibrary: vi.fn(() =>
        Promise.reject(new IpcError(IPC_ERROR_CODES.HANDLER_FAULT, 'CatalogSessionError')),
      ),
    });
    const { result } = renderHook(() => useLibrary(), { wrapper: wrapper(api) });

    await act(async () => {
      await result.current.openLibrary({ path: '/lib/elena' });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).not.toBeNull();
    expect(result.current.error).toMatch(/please try again/i);
    expect(result.current.error).not.toMatch(/ERR_IPC|CatalogSessionError/);
  });
});
