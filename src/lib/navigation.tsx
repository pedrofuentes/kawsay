// Minimal, dependency-free view router. The app only has a handful of calm
// screens, so a typed state machine in React context is lighter and clearer than
// a routing library (see ADR-0015). U1 (timeline) and U2 (search) read the active
// view here and call `navigate()` to move between the main sections.
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { ItemCardDTO } from '@shared/kawsay-api';

/** The discrete screens the renderer can show. */
export type View =
  | { name: 'onboarding' }
  | { name: 'timeline' }
  | { name: 'search' }
  | { name: 'add-memories' }
  | { name: 'settings' }
  // The Collections browser view (#437) — a sidebar-reachable list of every
  // browsable collection.
  | { name: 'collections' }
  // One collection opened on its own (#437). `collectionName` is the tile's
  // already-known name, carried so the detail heading can render immediately
  // (no blank-heading flash) while its own read confirms the current name and
  // fetches the paginated members — mirrors how the 'item' case below carries
  // the whole opened tile rather than re-fetching it.
  | { name: 'collection'; collectionId: string; collectionName: string }
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

/** The best-known favourite flag per item id — the optimistic value while a
 *  `catalog:setFavourite` save is in flight, then the durable value it persisted —
 *  overlaid on the (possibly stale) flag frozen into a `siblings`/timeline snapshot
 *  at open time. */
export type FavouriteOverrides = Readonly<Record<string, boolean>>;

/** The live favourite state for one item id, owned by the provider so it survives
 *  ItemView's id-keyed remount. `value` is optimistic-then-reconciled; `saving` is
 *  true while a save is in flight (from ANY mount), so the reopened memory shows the
 *  pending state and disables its toggle until the one save settles (#458). */
export interface FavouriteState {
  value: boolean;
  saving: boolean;
}

/** The outcome handed back to `settleFavouriteSave`: the durable flag on success,
 *  or a reverting fallback (the pre-toggle value) on a failed save that persisted
 *  nothing. */
export type FavouriteSettlement =
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly revertTo: boolean };

export interface NavigationValue {
  view: View;
  navigate: (view: View) => void;
  /**
   * The best-known favourite flag per item id (optimistic-or-settled), for
   * overlay consumers (Timeline, ItemView's sibling snapshot). Derived from the
   * provider-owned favourite state, which lives ABOVE MainApp's
   * `<ItemView key={`item-${id}`}/>` so it OUTLIVES the id-keyed remount.
   */
  favouriteOverrides: FavouriteOverrides;
  /** The live favourite state for one id, or `undefined` if it was never toggled
   *  this session (caller then falls back to the item's own flag). Read by
   *  `useFavourite` so every mount of the same memory — including one that remounted
   *  while a save was still in flight — reflects the SAME value and busy state. */
  favouriteStateFor: (id: string) => FavouriteState | undefined;
  /**
   * Begin an optimistic favourite save: record `optimistic` as the value, mark the
   * id busy, bump its monotonic per-id attempt token, and return that token. The
   * token is scoped to the item id (NOT to a hook instance), so an out-of-order
   * OLDER reply — even one from an ItemView that has since unmounted — can be
   * recognised and dropped by `settleFavouriteSave` (#458 cross-remount clobber).
   */
  beginFavouriteSave: (id: string, optimistic: boolean) => number;
  /**
   * Settle a save started with `beginFavouriteSave`. Applies the outcome ONLY when
   * `token` is not older than the last settled token for this id — a superseded
   * reply must never regress a newer intent. Clears `saving` only when this token is
   * the newest attempt (an older reply must not re-enable the control while a newer
   * save is still pending). Returns whether it applied, so the caller can gate a
   * failure announcement. Safe to call from an unmounted child: it targets this
   * always-mounted provider.
   */
  settleFavouriteSave: (id: string, token: number, outcome: FavouriteSettlement) => boolean;
  /**
   * A monotonic counter bumped whenever catalog data the timeline reads has
   * CHANGED beneath it — today only a completed import (#432 review). MainApp
   * now keeps Timeline mounted across navigation so its loaded pages/scroll
   * survive a round trip (#432), which also removed the remount that used to
   * refetch on return. `useTimeline` takes this as a refetch dependency, so a
   * real data mutation refreshes the cached, mounted timeline — while a pure
   * navigation round trip (unchanged data) never bumps it and so still
   * preserves scroll + loaded pages. Owned here, ABOVE MainApp, so the signal
   * outlives the view that triggered it (e.g. the Add Memories view unmounts as
   * the user returns to the timeline).
   */
  dataVersion: number;
  /** Signal that timeline-backing catalog data changed, so the mounted timeline
   *  refetches page 1 on its next render. Call ONLY on a real mutation (a
   *  completed import now; undo/delete later) — never on plain navigation, which
   *  must keep preserving scroll + loaded pages (#432 AC). */
  invalidateTimeline: () => void;
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
  const [favourites, setFavourites] = useState<Readonly<Record<string, FavouriteState>>>({});
  const [dataVersion, setDataVersion] = useState(0);

  // Monotonic per-id save sequence, kept in a ref so it survives ItemView's id-keyed
  // remount and is readable synchronously from a settlement handler. `attempt` is
  // bumped on each begin; `settled` records the newest token already applied, so a
  // later OLDER reply is dropped.
  const favouriteSeqRef = useRef<Map<string, { attempt: number; settled: number }>>(new Map());

  const favouriteStateFor = useCallback(
    (id: string): FavouriteState | undefined => favourites[id],
    [favourites],
  );

  const beginFavouriteSave = useCallback((id: string, optimistic: boolean): number => {
    const seq = favouriteSeqRef.current.get(id) ?? { attempt: 0, settled: 0 };
    const attempt = seq.attempt + 1;
    favouriteSeqRef.current.set(id, { attempt, settled: seq.settled });
    setFavourites((prev) => ({ ...prev, [id]: { value: optimistic, saving: true } }));
    return attempt;
  }, []);

  const settleFavouriteSave = useCallback(
    (id: string, token: number, outcome: FavouriteSettlement): boolean => {
      const seq = favouriteSeqRef.current.get(id) ?? { attempt: 0, settled: 0 };
      // Superseded by a newer settlement (out-of-order OLDER reply) — drop entirely,
      // reconcile included, so it never regresses the newer value.
      if (token < seq.settled) {
        return false;
      }
      favouriteSeqRef.current.set(id, { attempt: seq.attempt, settled: token });
      const isNewestAttempt = token === seq.attempt;
      const value = outcome.ok ? outcome.value : outcome.revertTo;
      setFavourites((prev) => {
        const current = prev[id];
        // Only the newest in-flight save clears the busy flag; an older reply must not
        // re-enable the control while a newer save is still pending.
        const saving = isNewestAttempt ? false : (current?.saving ?? false);
        if (current !== undefined && current.value === value && current.saving === saving) {
          return prev;
        }
        return { ...prev, [id]: { value, saving } };
      });
      return true;
    },
    [],
  );

  const favouriteOverrides = useMemo<FavouriteOverrides>(() => {
    const overrides: Record<string, boolean> = {};
    for (const [id, state] of Object.entries(favourites)) {
      overrides[id] = state.value;
    }
    return overrides;
  }, [favourites]);

  const invalidateTimeline = useCallback((): void => {
    setDataVersion((version) => version + 1);
  }, []);

  const value = useMemo<NavigationValue>(
    () => ({
      view,
      navigate: (next: View) => setView(next),
      favouriteOverrides,
      favouriteStateFor,
      beginFavouriteSave,
      settleFavouriteSave,
      dataVersion,
      invalidateTimeline,
    }),
    [
      view,
      favouriteOverrides,
      favouriteStateFor,
      beginFavouriteSave,
      settleFavouriteSave,
      dataVersion,
      invalidateTimeline,
    ],
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
