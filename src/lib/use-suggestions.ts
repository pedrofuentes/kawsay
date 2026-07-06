// The renderer-side read/act layer for the SUGGESTED-COLLECTIONS review tray (#273
// / ADR-0030 / AC-32). Like `useItemCategories`, it keeps the DEFAULT-OFF invariant
// honest: while the tray is disabled (the feature is not offered or the user has not
// opted in) it never even asks for suggestions, and it drops any it had — so an
// opted-out catalog never fetches or shows a suggestion. Nothing here materialises a
// collection on its own; every write is caller-initiated from a click, and each
// action refreshes the tray straight from the returned view (no manual re-fetch), so
// the acted-on suggestion simply drops out.
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SuggestionDTO,
  SuggestionMergeTargetDTO,
  SuggestionsViewDTO,
} from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';

/** The calm empty tray — a stable reference so repeated resets never re-render. */
const EMPTY_VIEW: SuggestionsViewDTO = { suggestions: [], collections: [] };

export interface UseSuggestionsResult {
  /** The pending suggestions to review (empty while disabled, loading, or caught up). */
  suggestions: SuggestionDTO[];
  /** The real collections a suggestion may be merged into (accept targets). */
  collections: SuggestionMergeTargetDTO[];
  /** True while the first suggestions read is in flight. */
  loading: boolean;
  /**
   * True when the LAST curation action (accept/merge/dismiss) failed. Nothing
   * changed on disk (the action is atomic) and the tray is untouched, so this is a
   * NON-BLOCKING hint the UI can show to invite a retry. Cleared by the next
   * successful action or when the feature is disabled. Local-only — never reported.
   */
  actionError: boolean;
  /** Accept a suggestion (optionally renamed) — materialises the collection; refreshes the tray. */
  accept(input: { categoryId: string; name?: string }): void;
  /** Merge a suggestion into an existing collection; refreshes the tray. */
  merge(input: { categoryId: string; intoCollectionId: string }): void;
  /** Dismiss a suggestion durably (not re-proposed); refreshes the tray. */
  dismiss(input: { categoryId: string; name?: string }): void;
}

export function useSuggestions(enabled: boolean): UseSuggestionsResult {
  const api = useKawsayApi();
  const [view, setView] = useState<SuggestionsViewDTO>(EMPTY_VIEW);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState(false);

  // Monotonic per-action generation. Each curation action (accept/merge/dismiss)
  // captures its own value at call time; the resolve/reject applies its outcome
  // ONLY if that value still matches the latest generation. It is bumped both by
  // every action AND whenever this effect re-runs (enable/disable/api change), so
  // an outcome belonging to a superseded action — a newer action began, or the
  // feature was toggled off (then possibly back on) while it was in flight — is
  // dropped instead of resurfacing a spurious "couldn't save" hint (#407).
  const actionGenerationRef = useRef(0);
  // Mirrors `enabled` for the async callbacks: a rejection that lands after the
  // feature was disabled must never re-flag the calm notice on a hidden tray.
  const enabledRef = useRef(enabled);

  useEffect(() => {
    enabledRef.current = enabled;
    // Any action still in flight belongs to the previous enabled-state; supersede
    // it so its late outcome cannot set state after this reset (#407).
    actionGenerationRef.current += 1;
    // DEFAULT-OFF: while disabled we never ask for suggestions, and we drop any we
    // had so turning the feature off empties the tray at once.
    if (api === undefined || !enabled) {
      setView(EMPTY_VIEW);
      setLoading(false);
      setActionError(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    void api
      .listSuggestions()
      .then((next) => {
        if (active) {
          setView(next);
          setLoading(false);
        }
      })
      .catch(() => {
        // A failed read leaves the tray empty rather than guessing; the next open
        // (or opt-in toggle) tries again.
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, enabled]);

  // The shared runner behind accept/merge/dismiss. They are independent verbs but
  // share ONE curation contract: on success repaint the tray and clear the notice;
  // on failure surface the calm retry hint — UNLESS this attempt has been
  // superseded (a newer action began) or the feature was disabled meanwhile, in
  // which case its stale outcome is dropped (#407). Centralising it keeps the guard
  // identical across all three callbacks.
  const runAction = useCallback(
    (perform: (client: NonNullable<typeof api>) => Promise<SuggestionsViewDTO>): void => {
      if (api === undefined) {
        return;
      }
      const generation = ++actionGenerationRef.current;
      void perform(api)
        .then((next) => {
          if (actionGenerationRef.current !== generation || !enabledRef.current) {
            // Superseded or post-disable success — a newer action (or a toggle)
            // owns the current tray, so applying this stale view would regress it.
            return;
          }
          setView(next);
          setActionError(false);
        })
        .catch(() => {
          if (actionGenerationRef.current !== generation || !enabledRef.current) {
            // Superseded or post-disable rejection — dropping it keeps a stale
            // failure from resurfacing the notice after a later success cleared it
            // or after the feature was turned off (#407).
            return;
          }
          // A rejected action leaves the tray untouched and nothing on disk changed
          // (the action is atomic); surface a calm hint so the user can retry.
          setActionError(true);
        });
    },
    [api],
  );

  const accept = useCallback(
    (input: { categoryId: string; name?: string }): void => {
      runAction((client) => client.acceptSuggestion(input));
    },
    [runAction],
  );

  const merge = useCallback(
    (input: { categoryId: string; intoCollectionId: string }): void => {
      runAction((client) => client.mergeSuggestion(input));
    },
    [runAction],
  );

  const dismiss = useCallback(
    (input: { categoryId: string; name?: string }): void => {
      runAction((client) => client.dismissSuggestion(input));
    },
    [runAction],
  );

  return {
    suggestions: view.suggestions,
    collections: view.collections,
    loading,
    actionError,
    accept,
    merge,
    dismiss,
  };
}
