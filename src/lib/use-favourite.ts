// The renderer-side act layer for the favourite toggle (#434, part of #434 —
// arrow-nav and the tour are separate later slices). Mirrors
// `useCategorizationStatus`'s optimistic-then-reconcile shape: reflect the click
// immediately (the toggle feels instant), persist via the validated
// `catalog:setFavourite` channel, and revert to the prior state on a failed save
// so the UI never claims something is favourited that isn't actually on disk.
//
// Two async guards, ported from `useItemCategories` (#360/#383), keep that honest
// against the reachable races: (1) a MOUNT guard, because `MainApp` keys ItemView
// by item id — navigating to another memory fully unmounts this instance, and a
// user who toggles then clicks Back unmounts it while the save is still in flight;
// (2) a monotonic SEQUENCE guard, because `ipcRenderer.invoke` gives no ordering
// guarantee, so two quick toggles can resolve out of order and a stale older reply
// must never clobber the newer one. `isSaving` also disables the control while a
// save is pending, discouraging the rapid re-click that triggers the race.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useKawsayApi } from './kawsay-api';

export interface UseFavouriteResult {
  /** The current (optimistic, then reconciled) favourite state. */
  isFavourite: boolean;
  /** True while a save is in flight — the toggle should be disabled/aria-busy. */
  isSaving: boolean;
  /**
   * A polite live-region announcement for the most recent toggle — cleared on
   * item switch. Empty until the first toggle.
   */
  announcement: string;
  /** Flip the favourite flag for the current item (caller-initiated only). */
  toggle(): void;
}

/** The one user-facing message for a favourite save that did not persist —
 *  calm, honest that nothing changed, consistent with the categorization
 *  correction failure copy. */
const SAVE_FAILURE_MESSAGE = "We couldn't save that change just now. Nothing was lost.";

/**
 * Track and toggle ONE item's favourite flag. `itemId`/`initial` describe the
 * memory currently being viewed; a new `itemId` resets the visible state to that
 * item's own `initial` value and drops any stale announcement.
 *
 * `onSettled` (optional) is called with the durable `isFavourite` the main
 * process echoed back, but ONLY when a save actually persisted — never on a
 * failed/reverted save, and never for a settlement the monotonic SEQUENCE guard
 * dropped (a stale older reply must not regress a newer one). It deliberately is
 * NOT gated behind the mount guard: it reconciles PERSISTENT owner state (the
 * navigation-owned favourite override map), which stays mounted while this
 * ItemView unmounts on its id-keyed remount — so a save that settles only after
 * the user arrowed away still lands the corrected flag for the next mount to read
 * (#458 before-settle race). Held in a ref so a changing callback identity never
 * re-runs the item-switch effect or stales the toggle closure.
 */
export function useFavourite(
  itemId: string,
  initial: boolean,
  onSettled?: (isFavourite: boolean) => void,
): UseFavouriteResult {
  const api = useKawsayApi();
  const [isFavourite, setIsFavourite] = useState(initial);
  const [isSaving, setIsSaving] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  });

  // False after unmount, so a late-arriving save settlement never calls setState
  // on a dead tree (mirrors useItemCategories's mountedRef). The user can toggle
  // then click Back — ItemView unmounts while the invoke is still pending.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Monotonic per-toggle sequence. Each toggle captures its own `seq` when it is
  // SENT; a settlement applies its outcome only if a NEWER toggle has not already
  // settled (`seq >= lastSettledSeqRef`). `ipcRenderer.invoke` does not guarantee
  // response order == request order, so without this a stale older reply could
  // clobber the newer state (the symmetric residual guarded in useItemCategories).
  const attemptSeqRef = useRef(0);
  const lastSettledSeqRef = useRef(0);

  useEffect(() => {
    setIsFavourite(initial);
    setIsSaving(false);
    setAnnouncement('');
    // A fresh item starts its own sequence clean.
    attemptSeqRef.current = 0;
    lastSettledSeqRef.current = 0;
    // `initial` intentionally excluded: it is the item's value AT MOUNT/ITEM-
    // SWITCH time only. Re-running this effect every time `initial` ticks (e.g.
    // after our own optimistic setIsFavourite settles) would fight the toggle's
    // own state — the effect should fire on item identity change alone.
  }, [itemId]);

  const toggle = useCallback((): void => {
    if (api === undefined) {
      return;
    }
    const next = !isFavourite;
    const seq = ++attemptSeqRef.current;
    setIsFavourite(next);
    setIsSaving(true);
    setAnnouncement(next ? 'Added to favourites.' : 'Removed from favourites.');
    void api
      .setFavourite({ id: itemId, favourite: next })
      .then((result) => {
        // SEQUENCE guard first, and it drops the settlement ENTIRELY (reconcile
        // included): an out-of-order OLDER reply a newer toggle already settled must
        // never regress the persistent source with a stale value. Preserved from
        // #453 — `ipcRenderer.invoke` gives no response-order guarantee.
        if (seq < lastSettledSeqRef.current) {
          console.debug('[kawsay] favourite toggle result dropped; superseded');
          return;
        }
        lastSettledSeqRef.current = seq;
        // Reconcile the PERSISTENT owner (e.g. the navigation-owned favourite
        // override map) with what actually persisted — success path only, so a
        // failed/reverted save never writes a value not on disk. This runs even when
        // this ItemView has UNMOUNTED (the user toggled then arrowed away before the
        // save settled): it targets state the still-mounted parent owns, which
        // outlives ItemView's id-keyed remount, so the corrected flag is there for
        // the next mount to read (#458 before-settle race).
        onSettledRef.current?.(result.isFavourite);
        // The DISPLAYED toggle's own state stays MOUNT-guarded — no setState on a
        // dead tree, no React unmounted-update warning (#453 behaviour preserved).
        if (!mountedRef.current) {
          console.debug('[kawsay] favourite toggle display update skipped; unmounted');
          return;
        }
        setIsFavourite(result.isFavourite);
        // Only the newest in-flight save clears the busy state, so an older reply
        // can't re-enable the control while a newer save is still pending.
        if (seq === attemptSeqRef.current) {
          setIsSaving(false);
        }
      })
      .catch((error: unknown) => {
        if (seq < lastSettledSeqRef.current) {
          console.debug('[kawsay] favourite toggle rejection dropped; superseded', error);
          return;
        }
        lastSettledSeqRef.current = seq;
        // A FAILED save persisted NOTHING, so there is nothing to reconcile into the
        // persistent source — never call `onSettled` here (it is success-path only).
        // If this ItemView has unmounted there is likewise no display to revert.
        if (!mountedRef.current) {
          console.debug('[kawsay] favourite toggle rejection dropped; unmounted');
          return;
        }
        // Nothing on disk changed — fall back to the prior state so the toggle
        // never lies about what is actually persisted.
        console.warn('[kawsay] favourite toggle failed; reverting', error);
        setIsFavourite(!next);
        setAnnouncement(SAVE_FAILURE_MESSAGE);
        if (seq === attemptSeqRef.current) {
          setIsSaving(false);
        }
      });
  }, [api, itemId, isFavourite]);

  return { isFavourite, isSaving, announcement, toggle };
}
