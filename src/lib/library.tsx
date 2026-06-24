// Holds the currently open library plus the create/open actions, so any screen
// (onboarding now; timeline / search / settings later) can read which library is
// open and act on it. Async failures surface as a status + a stored message; the
// UI is responsible for showing reassuring copy, never the raw error.
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { KawsayAPI, LibrarySummaryDTO } from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';

export type LibraryStatus = 'idle' | 'loading' | 'error';

export interface CreateLibraryInput {
  path: string;
  personName?: string;
}

export interface OpenLibraryInput {
  path: string;
}

export interface LibraryContextValue {
  library: LibrarySummaryDTO | null;
  status: LibraryStatus;
  error: string | null;
  createLibrary: (input: CreateLibraryInput) => Promise<LibrarySummaryDTO | null>;
  openLibrary: (input: OpenLibraryInput) => Promise<LibrarySummaryDTO | null>;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

/** Shown (and logged) when no bridge is present, e.g. a browser-only preview. */
const NO_BRIDGE_MESSAGE = 'Kawsay is not connected on this device.';

export function LibraryProvider({ children }: { children: ReactNode }): ReactElement {
  const api = useKawsayApi();
  const [library, setLibrary] = useState<LibrarySummaryDTO | null>(null);
  const [status, setStatus] = useState<LibraryStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (
      operation: (bridge: KawsayAPI) => Promise<LibrarySummaryDTO>,
    ): Promise<LibrarySummaryDTO | null> => {
      if (api === undefined) {
        setStatus('error');
        setError(NO_BRIDGE_MESSAGE);
        return null;
      }
      setStatus('loading');
      setError(null);
      try {
        const summary = await operation(api);
        setLibrary(summary);
        setStatus('idle');
        return summary;
      } catch (cause) {
        setStatus('error');
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      }
    },
    [api],
  );

  const createLibrary = useCallback(
    (input: CreateLibraryInput) => run((bridge) => bridge.createLibrary(input)),
    [run],
  );

  const openLibrary = useCallback(
    (input: OpenLibraryInput) => run((bridge) => bridge.openLibrary(input)),
    [run],
  );

  const value = useMemo<LibraryContextValue>(
    () => ({ library, status, error, createLibrary, openLibrary }),
    [library, status, error, createLibrary, openLibrary],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const value = useContext(LibraryContext);
  if (value === null) {
    throw new Error('useLibrary must be used within a LibraryProvider.');
  }
  return value;
}
