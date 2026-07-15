// The renderer-side act layer for the favourite toggle (#434, part of #434 —
// arrow-nav and the tour are separate later slices). Mirrors
// `useCategorizationStatus`'s optimistic-then-reconcile shape: reflect the click
// immediately (the toggle feels instant), persist via the validated
// `catalog:setFavourite` channel, and revert to the prior state on a failed save
// so the UI never claims something is favourited that isn't actually on disk.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useKawsayApi } from './kawsay-api';

export interface UseFavouriteResult {
  /** The current (optimistic, then reconciled) favourite state. */
  isFavourite: boolean;
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
 * memory currently being viewed; switching to a different item (a new `itemId`)
 * resets the visible state to that item's own `initial` value and drops any
 * stale announcement.
 */
export function useFavourite(itemId: string, initial: boolean): UseFavouriteResult {
  const api = useKawsayApi();
  const [isFavourite, setIsFavourite] = useState(initial);
  const [announcement, setAnnouncement] = useState('');

  // The itemId this hook is CURRENTLY driving — a toggle result must match it
  // (mirrors useItemCategories's stale-result guard) or it belongs to a memory
  // the user has since navigated away from.
  const currentItemIdRef = useRef(itemId);

  useEffect(() => {
    currentItemIdRef.current = itemId;
    setIsFavourite(initial);
    setAnnouncement('');
    // `initial` intentionally excluded: it is the item's value AT MOUNT/ITEM-
    // SWITCH time only. Re-running this effect every time `initial` ticks (e.g.
    // after our own optimistic setIsFavourite settles) would fight the toggle's
    // own state — the effect should fire on item identity change alone.
  }, [itemId]);

  const toggle = useCallback((): void => {
    if (api === undefined) {
      return;
    }
    const capturedItemId = itemId;
    const next = !isFavourite;
    setIsFavourite(next);
    setAnnouncement(next ? 'Added to favourites.' : 'Removed from favourites.');
    void api
      .setFavourite({ id: itemId, favourite: next })
      .then((result) => {
        if (currentItemIdRef.current !== capturedItemId) {
          return; // stale — the user has moved on to a different memory
        }
        setIsFavourite(result.isFavourite);
      })
      .catch((error: unknown) => {
        console.warn('[kawsay] favourite toggle failed; reverting', error);
        if (currentItemIdRef.current !== capturedItemId) {
          return;
        }
        // Nothing on disk changed — fall back to the prior state so the toggle
        // never lies about what is actually persisted.
        setIsFavourite(!next);
        setAnnouncement(SAVE_FAILURE_MESSAGE);
      });
  }, [api, itemId, isFavourite]);

  return { isFavourite, announcement, toggle };
}
