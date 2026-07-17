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

/** The last SETTLED favourite flag per item id — the value a `catalog:setFavourite`
 *  save actually persisted (or reverted to on failure) — overlaid on the (possibly
 *  stale) flag frozen into a `siblings`/timeline snapshot at open time. Deliberately
 *  NOT the optimistic in-flight value: overlay consumers show settled truth so a save
 *  that later fails never leaves a phantom favourite on another view (#488). */
export type FavouriteOverrides = Readonly<Record<string, boolean>>;

/** The live favourite state for one item id, owned by the provider so it survives
 *  ItemView's id-keyed remount. `value` is the optimistic-then-reconciled value the
 *  mounted toggle shows; `saving` is true while a save is in flight (from ANY mount),
 *  so the reopened memory shows the pending state and disables its toggle until the
 *  one save settles (#458). `settledValue` is the last value a save actually PERSISTED
 *  (undefined until the first settlement) — the settled truth overlay consumers read,
 *  kept distinct from the optimistic `value` (#488). */
export interface FavouriteState {
  value: boolean;
  saving: boolean;
  settledValue?: boolean;
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
   * The last SETTLED favourite flag per item id, for overlay consumers (Timeline,
   * ItemView's sibling snapshot). Derived from the provider-owned favourite state,
   * which lives ABOVE MainApp's `<ItemView key={`item-${id}`}/>` so it OUTLIVES the
   * id-keyed remount. Deliberately excludes the optimistic in-flight value — that
   * stays scoped to the mounted toggle (`favouriteStateFor`) — so a save that later
   * fails never leaves a phantom favourite on another view (#488).
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
   * save is still pending). A non-newest reply also never moves `value`/`settledValue`
   * to a value the newest attempt's optimistic intent contradicts — the newest value
   * governs, so a superseded reply can't transiently flip the overlay on another view
   * (#494); it may still confirm settled truth that agrees with the newest value.
   * Returns whether it applied, so the caller can gate a failure announcement. Safe to
   * call from an unmounted child: it targets this always-mounted provider.
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
    // Optimistic value for the toggle; the last SETTLED value is preserved so overlay
    // consumers keep showing settled truth while this new save is in flight (#488).
    setFavourites((prev) => ({
      ...prev,
      [id]: { value: optimistic, saving: true, settledValue: prev[id]?.settledValue },
    }));
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
      setFavourites((prev) => {
        const current = prev[id];
        // A FAILED save reverts to the last SETTLED value known AT SETTLE TIME — not a
        // baseline frozen when the toggle was clicked. Disk truth can advance between
        // click and settle (a slow save that commits after a timeout+retry), and reading
        // it here keeps the revert honest — no phantom un-favourite. Fall back to the
        // caller's baseline (which carries `initial`) only when nothing has settled this
        // session (#493 review, F1). A successful save uses its persisted value.
        const value = outcome.ok ? outcome.value : (current?.settledValue ?? outcome.revertTo);
        // Only the newest in-flight save clears the busy flag; an older reply must not
        // re-enable the control while a newer save is still pending (#490).
        const saving = isNewestAttempt ? false : (current?.saving ?? false);
        // A NON-newest reply (`token < seq.attempt`, still in flight when it lands) must
        // never move `value`/`settledValue` to a value the newest attempt's optimistic
        // intent CONTRADICTS — the newest optimistic value governs. Applying a superseded,
        // differing value would transiently flip the overlay (seen on OTHER views) to a
        // stale value until the newer save settles (#494). This is reachable even without
        // being STRICTLY older than `settled`: the #489 timeout can settle token N, the
        // user retry as N+1, then N's real (differing) reply land. It may still CONFIRM
        // settled truth when it AGREES with the newest optimistic value (the benign
        // in-order case, #488) — that value already governs, so recording it is safe. We
        // keep the `settled` bookkeeping above regardless, so ordering still holds.
        if (!isNewestAttempt && current !== undefined && value !== current.value) {
          return prev;
        }
        // This settlement establishes the persisted truth for overlay consumers (#488):
        // the durable value on success, the reverted value on failure.
        if (
          current !== undefined &&
          current.value === value &&
          current.saving === saving &&
          current.settledValue === value
        ) {
          return prev;
        }
        return { ...prev, [id]: { value, saving, settledValue: value } };
      });
      return true;
    },
    [],
  );

  const favouriteOverrides = useMemo<FavouriteOverrides>(() => {
    const overrides: Record<string, boolean> = {};
    // Settled truth only: expose an id ONLY once a save has actually persisted a
    // value for it. An id that was never toggled — or whose first save is still in
    // flight — is absent, so overlay consumers fall back to the card's own frozen
    // (persisted-at-fetch) flag rather than a phantom optimistic value (#488).
    for (const [id, state] of Object.entries(favourites)) {
      if (state.settledValue !== undefined) {
        overrides[id] = state.settledValue;
      }
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
