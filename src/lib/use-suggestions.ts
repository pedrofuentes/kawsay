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
  KawsayAPI,
  SuggestionDTO,
  SuggestionMergeTargetDTO,
  SuggestionsViewDTO,
} from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';
import { useMutation } from './use-mutation';

/** One curation verb, deferred to call time: the accept/merge/dismiss click closes
 *  over its own input and runs against the live bridge. All three share ONE
 *  latest-wins mutation guard (below), so a superseded outcome is dropped (#407). */
type CurationTask = (client: KawsayAPI) => Promise<SuggestionsViewDTO>;

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
  // The calm "couldn't save" hint. Deliberately a STICKY local flag rather than a
  // read of the mutation's transient status: once raised by a committed failure it
  // stays up CONTINUOUSLY — including through an in-flight retry — and is lowered
  // ONLY by a committed success or by disabling the feature. (Reading
  // `status === 'error'` would blink it off the instant a retry goes pending, a
  // spurious mid-retry reassurance.) It is set/cleared exclusively in the mutation
  // callbacks below, which the primitive fires only for the latest, non-superseded,
  // still-enabled action (#407).
  const [actionError, setActionError] = useState(false);

  // The per-action latest-wins guard (#407) lives in the shared `useMutation`
  // primitive: each curation click captures a monotonic generation, and its
  // outcome commits ONLY if it is still the latest AND the tray is still enabled
  // AND still mounted. So a superseded action — a newer action began, or the
  // feature was toggled off (then possibly back on) while it was in flight — is
  // dropped. `enabled` is false while the feature is off OR the bridge is absent,
  // which both disables mutation AND (via the primitive) supersedes any in-flight
  // action. On success we repaint the tray from the returned view and clear the
  // hint; on failure we raise it.
  const actionsEnabled = enabled && api !== undefined;
  const { mutate: runAction } = useMutation<CurationTask, SuggestionsViewDTO>({
    mutationFn: (task) => task(api as KawsayAPI),
    enabled: actionsEnabled,
    onSuccess: (next) => {
      setView(next);
      setActionError(false);
    },
    onError: () => setActionError(true),
  });

  useEffect(() => {
    // DEFAULT-OFF: while disabled we never ask for suggestions, and we drop any we
    // had so turning the feature off empties the tray at once. We also lower the
    // calm hint — a hidden tray shows no lingering "couldn't save" notice (#407).
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
