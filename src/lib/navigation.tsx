// Minimal, dependency-free view router. The app only has a handful of calm
// screens, so a typed state machine in React context is lighter and clearer than
// a routing library (see ADR-0015). U1 (timeline) and U2 (search) read the active
// view here and call `navigate()` to move between the main sections.
import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { ItemCardDTO } from '@shared/kawsay-api';

/** The discrete screens the renderer can show. */
export type View =
  | { name: 'onboarding' }
  | { name: 'timeline' }
  | { name: 'search' }
  | { name: 'add-memories' }
  | { name: 'settings' }
  // One memory opened on its own (#136) — carries the tile the user activated so
  // the view needs no re-fetch, plus where they came from so "back" returns there.
  //
  // `siblings` (#434) is the ordered list of memories the item was opened FROM
  // (Timeline's newest-first page, or Search's current result set) — it lets
  // ItemView derive the previous/next memory for ←/→ navigation entirely from
  // data the renderer already has in hand, with no new IPC channel. `via` is a
  // transient hint set only when arrow-key/Prev/Next navigation produced this
  // view, so ItemView can announce the move politely without announcing a
  // freshly-OPENED item too (which its own focused heading already covers).
  | {
      name: 'item';
      item: ItemCardDTO;
      from?: View;
      siblings?: ItemCardDTO[];
      via?: 'prev' | 'next';
    };

export interface NavigationValue {
  view: View;
  navigate: (view: View) => void;
}

const NavigationContext = createContext<NavigationValue | null>(null);

const DEFAULT_VIEW: View = { name: 'onboarding' };

export function NavigationProvider({
  initialView,
  children,
}: {
  initialView?: View;
  children: ReactNode;
}): ReactElement {
  const [view, setView] = useState<View>(initialView ?? DEFAULT_VIEW);
  const value = useMemo<NavigationValue>(
    () => ({ view, navigate: (next: View) => setView(next) }),
    [view],
  );
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): NavigationValue {
  const value = useContext(NavigationContext);
  if (value === null) {
    throw new Error('useNavigation must be used within a NavigationProvider.');
  }
  return value;
}
