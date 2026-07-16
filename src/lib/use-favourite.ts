// The renderer-side act layer for the favourite toggle (#434). It reflects a click
// immediately (the toggle feels instant), persists via the validated
// `catalog:setFavourite` channel, and reverts on a failed save so the UI never
// claims something is favourited that isn't actually on disk.
//
// The value and the in-flight `saving` flag are NOT held in this hook — they live in
// the navigation provider, keyed by item id (see `navigation.tsx`). `MainApp` keys
// `<ItemView key={`item-${id}`}/>`, so arrowing between memories fully UNMOUNTS this
// hook; keeping the state here meant a save left in flight across that remount lost
// its saving/sequence guards, and the reopened memory showed the stale open-time
// value on an enabled control — a re-click there could start a second save whose
// older in-flight reply arrived last and clobbered the newer intent, inverting the
// persisted value (#458). Owning the state ABOVE the remount closes that: every mount
// of the same id reads the SAME value + busy state, and the per-id sequence token
// drops an out-of-order older reply even when it belongs to an unmounted ItemView.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useKawsayApi } from './kawsay-api';
import { useNavigation } from './navigation';

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
 * How long to wait for `catalog:setFavourite` before treating the save as failed.
 * The busy flag now lives in the always-mounted navigation provider and no longer
 * self-heals on ItemView's id-keyed remount (#458/#487), so an invoke that never
 * settles — e.g. the main process wedged on DB contention during an import — would
 * otherwise leave this item's toggle disabled for the rest of the session. The
 * timeout drives the normal revert path; a real reply arriving later is dropped by
 * the provider's per-id sequence gate (#489).
 */
export const FAVOURITE_SAVE_TIMEOUT_MS = 10_000;

/** Reject `promise` with `onTimeout()`'s error if it has not settled within `ms`.
 *  Clears the timer on settle so a resolved save leaves nothing pending. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

/**
 * Track and toggle ONE item's favourite flag. `itemId`/`initial` describe the
 * memory currently being viewed; the visible value and busy state come from the
 * provider-owned favourite state for `itemId` (so they survive an id-keyed remount),
 * falling back to `initial` for a memory not toggled this session.
 */
export function useFavourite(itemId: string, initial: boolean): UseFavouriteResult {
  const api = useKawsayApi();
  const { favouriteStateFor, beginFavouriteSave, settleFavouriteSave } = useNavigation();
  const [announcement, setAnnouncement] = useState('');

  // Optimistic-or-settled value + in-flight flag, owned by the provider and keyed by
  // id — the same for every mount of this memory, including a remount over a still
  // in-flight save.
  const favourite = favouriteStateFor(itemId);
  const isFavourite = favourite?.value ?? initial;
  const isSaving = favourite?.saving ?? false;

  // A fresh item drops any stale announcement (the value/busy state are keyed by id
  // in the provider, so they need no reset here).
  useEffect(() => {
    setAnnouncement('');
  }, [itemId]);

  // False after unmount, so a late-arriving save settlement never announces on a dead
  // tree. The reconcile itself still lands — it targets the always-mounted provider —
  // but the live-region text belongs to this instance.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const toggle = useCallback((): void => {
    if (api === undefined) {
      return;
    }
    const current = favouriteStateFor(itemId)?.value ?? initial;
    const next = !current;
    const token = beginFavouriteSave(itemId, next);
    setAnnouncement(next ? 'Added to favourites.' : 'Removed from favourites.');
    void withTimeout(
      api.setFavourite({ id: itemId, favourite: next }),
      FAVOURITE_SAVE_TIMEOUT_MS,
      () => new Error('catalog:setFavourite timed out'),
    )
      .then((result) => {
        const applied = settleFavouriteSave(itemId, token, { ok: true, value: result.isFavourite });
        if (!applied) {
          // A newer toggle already settled — this reply is stale and was dropped.
          console.debug('[kawsay] favourite save settled after a newer toggle; dropping', itemId);
        }
      })
      .catch((error: unknown) => {
        // Revert to the pre-toggle value — a failed (or timed-out) save persisted
        // nothing, so the UI must not keep claiming the change. The provider drops
        // this if a newer toggle already settled (an older reply must never regress
        // the newer intent).
        const applied = settleFavouriteSave(itemId, token, { ok: false, revertTo: current });
        if (!applied) {
          console.debug('[kawsay] favourite revert superseded by a newer toggle; dropping', itemId);
          return;
        }
        // The value reverted on the always-mounted provider regardless; only the
        // announcement, which belongs to this (possibly dead) instance, is guarded.
        if (!mountedRef.current) {
          console.debug('[kawsay] favourite reverted after unmount; announcement skipped', itemId);
          return;
        }
        console.warn('[kawsay] favourite toggle failed; reverting', error);
        setAnnouncement(SAVE_FAILURE_MESSAGE);
      });
  }, [api, itemId, initial, favouriteStateFor, beginFavouriteSave, settleFavouriteSave]);

  return { isFavourite, isSaving, announcement, toggle };
}
