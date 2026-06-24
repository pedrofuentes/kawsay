// Access layer for the typed `window.kawsayAPI` preload bridge. Everything the
// renderer does with the main process flows through this context, so tests can
// inject a fake and a plain browser preview (no Electron, no bridge) degrades
// gracefully instead of crashing.
import { createContext, useContext } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { KawsayAPI } from '@shared/kawsay-api';

const KawsayApiContext = createContext<KawsayAPI | undefined>(undefined);

/** Read the bridge the preload script attaches to `window`, if present. */
function resolveBridge(): KawsayAPI | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return (window as { kawsayAPI?: KawsayAPI }).kawsayAPI;
}

export function KawsayApiProvider({
  api,
  children,
}: {
  api?: KawsayAPI;
  children: ReactNode;
}): ReactElement {
  const resolved = api ?? resolveBridge();
  return <KawsayApiContext.Provider value={resolved}>{children}</KawsayApiContext.Provider>;
}

/**
 * The typed Kawsay API, or `undefined` when running outside Electron (browser
 * preview). Callers must tolerate the absence rather than assume a bridge.
 */
export function useKawsayApi(): KawsayAPI | undefined {
  return useContext(KawsayApiContext);
}
