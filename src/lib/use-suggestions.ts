// The renderer-side read/act layer for the SUGGESTED-COLLECTIONS review tray (#273
// / ADR-0030 / AC-32). Like `useItemCategories`, it keeps the DEFAULT-OFF invariant
// honest: while the tray is disabled (the feature is not offered or the user has not
// opted in) it never even asks for suggestions, and it drops any it had — so an
// opted-out catalog never fetches or shows a suggestion. Nothing here materialises a
// collection on its own; every write is caller-initiated from a click, and each
// action refreshes the tray straight from the returned view (no manual re-fetch), so
// the acted-on suggestion simply drops out.
import { useCallback, useEffect, useState } from 'react';
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

  useEffect(() => {
    // DEFAULT-OFF: while disabled we never ask for suggestions, and we drop any we
    // had so turning the feature off empties the tray at once.
    if (api === undefined || !enabled) {
      setView(EMPTY_VIEW);
      setLoading(false);
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

  const accept = useCallback(
    (input: { categoryId: string; name?: string }): void => {
      if (api === undefined) {
        return;
      }
      void api
        .acceptSuggestion(input)
        .then(setView)
        .catch(() => {
          // A rejected action leaves the tray untouched; the user can retry, and
          // nothing on disk changed.
        });
    },
    [api],
  );

  const merge = useCallback(
    (input: { categoryId: string; intoCollectionId: string }): void => {
      if (api === undefined) {
        return;
      }
      void api
        .mergeSuggestion(input)
        .then(setView)
        .catch(() => {});
    },
    [api],
  );

  const dismiss = useCallback(
    (input: { categoryId: string; name?: string }): void => {
      if (api === undefined) {
        return;
      }
      void api
        .dismissSuggestion(input)
        .then(setView)
        .catch(() => {});
    },
    [api],
  );

  return {
    suggestions: view.suggestions,
    collections: view.collections,
    loading,
    accept,
    merge,
    dismiss,
  };
}
