// The renderer-side read/act layer for the opt-in categorization surface (#270 /
// ADR-0030). Two hooks keep the DEFAULT-OFF invariant honest: `useCategorizationStatus`
// reads the gate (is the feature `offered` — a bundled gazetteer — and has the user
// `optedIn`) and drives the consent toggle; `useItemCategories` fetches ONE item's
// explainable chips, but ONLY when the caller says it is enabled (opted in), so a
// opted-out catalog never even asks for chips. Nothing here organizes on its own —
// every write is caller-initiated from a click, and corrections refresh the chips
// straight from the returned list (no manual re-fetch).
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CategorizationCorrectionDTO,
  CategorizationStatusDTO,
  ItemCategoryDTO,
} from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';
import { useQuery } from './use-query';

export interface UseCategorizationStatusResult {
  /** True only once the gazetteer asset is bundled — the whole surface is hidden otherwise. */
  offered: boolean;
  /** The durable opt-in preference (default-off). */
  optedIn: boolean;
  /** True while the first status read is in flight. */
  loading: boolean;
  /** Persist a new opt-in choice (caller-initiated from the consent toggle only). */
  setOptedIn(next: boolean): void;
}

export function useCategorizationStatus(): UseCategorizationStatusResult {
  const api = useKawsayApi();
  // The gate read (is the surface offered, and has the user opted in) now runs
  // through the shared useQuery primitive (#443): the bespoke `active` staleness
  // flag collapses into its race guard. It deliberately does NOT opt into the
  // stale-while-revalidate cache: seeding the card from a cached `optedIn` while a
  // background revalidation is still in flight would open a window where an
  // optimistic toggle (`setData`, which does not bump the fetch generation) could
  // be transiently clobbered by the in-flight read committing the stale value —
  // a settings switch visibly flipping back. The no-flash benefit is marginal for
  // a settings card, so re-entry goes through `loading` exactly as before (#443 review).
  const query = useQuery<CategorizationStatusDTO>({
    // `null` while the bridge is missing keeps the query idle (loading:false,
    // offered:false) rather than guessing the feature is available.
    key: api === undefined ? null : 'categorization-status',
    fetcher: () => {
      if (api === undefined) {
        return Promise.reject(new Error('bridge unavailable'));
      }
      return api.getCategorizationStatus();
    },
  });
  const { setData } = query;
  // A failed read leaves the surface hidden (offered stays false — data undefined)
  // rather than surfacing an error; the next open revalidates. `loading` is true
  // only while the FIRST read is in flight.

  const setOptedIn = useCallback(
    (next: boolean): void => {
      if (api === undefined) {
        return;
      }
      // Reflect the choice immediately (the toggle feels instant) by writing the
      // optimistic value straight into the query's data, then reconcile with the
      // durable value the main process echoes back.
      setData((prev) => ({ offered: prev?.offered ?? true, optedIn: next }));
      void api
        .setCategorizationConsent({ optedIn: next })
        .then((result) => {
          setData((prev) => ({ offered: prev?.offered ?? true, optedIn: result.optedIn }));
        })
        .catch(() => {
          // Persisting failed — fall back to the previous state so the toggle never
          // lies about what is actually stored on disk.
          setData((prev) => ({ offered: prev?.offered ?? true, optedIn: !next }));
        });
    },
    [api, setData],
  );

  return {
    offered: query.data?.offered ?? false,
    optedIn: query.data?.optedIn ?? false,
    loading: query.status === 'loading',
    setOptedIn,
  };
}

export interface UseItemCategoriesResult {
  /** The item's explainable chips (empty while disabled, loading, or uncategorized). */
  categories: ItemCategoryDTO[];
  /** True while the first chip read is in flight. */
  loading: boolean;
  /**
   * Apply a user correction and refresh the chips straight from the returned
   * list. On a rejected save nothing on disk changes and the visible chips stay
   * put: {@link correctionError} then carries the calm retry copy and
   * {@link retryCorrection} replays the attempt.
   */
  applyCorrection(input: CategorizationCorrectionDTO): void;
  /**
   * Non-null when the most recent correction did NOT save (e.g. DB busy, no
   * open library). Carries calm, non-technical copy for an accessible alert.
   * Nothing on disk changed — the user can retry.
   */
  correctionError: CorrectionError | null;
  /**
   * Re-attempt the last correction that failed. No-op if there is nothing to
   * retry. Clears the error banner on success.
   */
  retryCorrection(): void;
}

/** Calm, non-technical failure surfaced to the user via ErrorBanner. */
export interface CorrectionError {
  message: string;
}

/**
 * The one and only user-facing message for a correction that did not save.
 * Deliberately non-technical (no error codes / stack), calm ("nothing was
 * lost"), and honest that a retry is the way forward.
 */
const CORRECTION_FAILURE_MESSAGE =
  "We couldn't save that change just now. Nothing was lost — please try again.";

export function useItemCategories(itemId: string, enabled: boolean): UseItemCategoriesResult {
  const api = useKawsayApi();
  const [categories, setCategories] = useState<ItemCategoryDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [correctionError, setCorrectionError] = useState<CorrectionError | null>(null);

  // The itemId the hook is CURRENTLY driving. A correction result must be
  // compared against this on resolve — anything else belongs to a memory the
  // user is no longer looking at.
  const currentItemIdRef = useRef(itemId);
  // False after unmount so a late-arriving correction result never calls
  // setState on a dead tree.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The last-attempted correction, kept in a ref so retry can replay it
  // without re-rendering when it changes.
  const lastCorrectionRef = useRef<CategorizationCorrectionDTO | null>(null);

  // Monotonic per-attempt sequence used to distinguish concurrent corrections
  // on the SAME item. Each runCorrection call captures its own `seq`; the
  // resolver compares against `lastSucceededSeqRef` — the highest seq that
  // has already settled successfully — so a stale, earlier rejection that
  // arrives AFTER a later success cannot surface a spurious retryable banner
  // (#383, the symmetric residual of #360). Reset on item-switch so a new
  // item starts clean.
  //
  // INTENTIONALLY NOT migrated onto the shared `useMutation` primitive (#486):
  // this is an ADVANCE-ONLY successor guard (`seq < lastSucceededSeqRef.current`,
  // a `<` comparison below, not `useMutation`'s `!==`). An earlier attempt that
  // happens to RESOLVE after a later one, but before any later one has yet
  // SUCCEEDED, is deliberately APPLIED — `lastSucceededSeqRef` only advances on a
  // committed success, so an earlier success is dropped ONLY once a later one has
  // actually landed, never merely because a later attempt has started (the
  // #360/#388 oracle pins exactly this). `useMutation`'s guard bumps its
  // generation the INSTANT a newer `mutate` starts, so it would unconditionally
  // drop that earlier success the moment a later correction began — an
  // observable divergence from the pinned behaviour. Keep this hand-rolled.
  const attemptSeqRef = useRef(0);
  const lastSucceededSeqRef = useRef(0);

  useEffect(() => {
    currentItemIdRef.current = itemId;
    // Correction feedback is per-item — leaving the item drops both the error
    // banner and the retry target, so an alert never lingers on a memory the
    // user is no longer looking at.
    setCorrectionError(null);
    lastCorrectionRef.current = null;
    attemptSeqRef.current = 0;
    lastSucceededSeqRef.current = 0;

    // DEFAULT-OFF: while the feature is disabled we never even ask for chips, and we
    // drop any previously-shown ones so turning it off hides everything at once.
    if (api === undefined || !enabled) {
      setCategories([]);
      setLoading(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    void api
      .listItemCategories({ itemId })
      .then((next) => {
        if (active) {
          setCategories(next);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, itemId, enabled]);

  const runCorrection = useCallback(
    (input: CategorizationCorrectionDTO): void => {
      if (api === undefined) {
        return;
      }
      // Capture the itemId at call time; the resolve MUST match it (and the
      // hook must still be mounted) or the result is stale and gets dropped.
      const capturedItemId = currentItemIdRef.current;
      // Bind this attempt to a monotonic seq so a stale rejection that
      // arrives AFTER a later success on the same item can be recognised
      // and dropped (#383).
      const seq = ++attemptSeqRef.current;
      lastCorrectionRef.current = input;
      void api
        .applyCategoryCorrection(input)
        .then((refreshed) => {
          if (!mountedRef.current || currentItemIdRef.current !== capturedItemId) {
            // Stale/unmounted resolve — drop it. Log for diagnostics so a
            // silent drop is still traceable in this local-only, telemetry-
            // free app.
            console.debug(
              '[kawsay] category correction result dropped; item switched or hook unmounted',
            );
            return;
          }
          if (seq < lastSucceededSeqRef.current) {
            // An out-of-order older success — a newer correction on the same
            // item already resolved successfully and applied its state.
            // Overwriting with this stale refresh would regress the visible
            // chips, so drop it (advance-only successor tracking).
            console.debug(
              '[kawsay] category correction success dropped; superseded by a later successful correction',
            );
            return;
          }
          lastSucceededSeqRef.current = seq;
          setCategories(refreshed);
          setCorrectionError(null);
          // Deliberately DO NOT clear `lastCorrectionRef` here: a sibling
          // correction may still be in flight, and clearing on ANY success
          // would strand its "Try again" button as a visible no-op (#360).
          // `correctionError === null` already gates the button, and the
          // ref is reset on item-switch (see the effect above), so a stale
          // non-null retry target is harmless.
        })
        .catch((error: unknown) => {
          if (!mountedRef.current || currentItemIdRef.current !== capturedItemId) {
            console.debug(
              '[kawsay] category correction rejection dropped; item switched or hook unmounted',
              error,
            );
            return;
          }
          if (seq < lastSucceededSeqRef.current) {
            // A later correction on the same item already resolved
            // successfully — displayed + on-disk state reflect the user's
            // latest intent, so surfacing this earlier attempt's rejection
            // would be a spurious retryable banner (#383). Drop it, with a
            // trace consistent with the other drop paths.
            console.debug(
              '[kawsay] category correction rejection dropped; superseded by a later successful correction',
              error,
            );
            return;
          }
          // Surface a calm, retryable failure — the current chips stay put
          // because nothing on disk changed. Log the underlying error via
          // the [kawsay] convention so support/dev can distinguish a
          // transient SQLITE_BUSY from a programming error (#361).
          console.warn('[kawsay] category correction failed; surfacing a retryable banner', error);
          setCorrectionError({ message: CORRECTION_FAILURE_MESSAGE });
        });
    },
    [api],
  );

  const retryCorrection = useCallback((): void => {
    const previous = lastCorrectionRef.current;
    if (previous === null) {
      return;
    }
    runCorrection(previous);
  }, [runCorrection]);

  // `runCorrection` is already memoized on `[api]`; a passthrough `useCallback`
  // would add an identical-identity wrapper with no extra semantics, so expose
  // it directly as the public `applyCorrection`.
  return { categories, loading, applyCorrection: runCorrection, correctionError, retryCorrection };
}
