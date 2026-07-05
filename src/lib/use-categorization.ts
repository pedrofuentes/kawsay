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
  const [status, setStatus] = useState<CategorizationStatusDTO | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (api === undefined) {
      setLoading(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    void api
      .getCategorizationStatus()
      .then((next) => {
        if (active) {
          setStatus(next);
          setLoading(false);
        }
      })
      .catch(() => {
        // A failed read leaves the surface hidden (offered stays false) rather than
        // guessing the feature is available; the next open will try again.
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api]);

  const setOptedIn = useCallback(
    (next: boolean): void => {
      if (api === undefined) {
        return;
      }
      // Reflect the choice immediately (the toggle feels instant), then reconcile
      // with the durable value the main process echoes back.
      setStatus((prev) => ({ offered: prev?.offered ?? true, optedIn: next }));
      void api
        .setCategorizationConsent({ optedIn: next })
        .then((result) => {
          setStatus((prev) => ({ offered: prev?.offered ?? true, optedIn: result.optedIn }));
        })
        .catch(() => {
          // Persisting failed — fall back to the previous state so the toggle never
          // lies about what is actually stored on disk.
          setStatus((prev) => ({ offered: prev?.offered ?? true, optedIn: !next }));
        });
    },
    [api],
  );

  return {
    offered: status?.offered ?? false,
    optedIn: status?.optedIn ?? false,
    loading,
    setOptedIn,
  };
}

export interface UseItemCategoriesResult {
  /** The item's explainable chips (empty while disabled, loading, or uncategorized). */
  categories: ItemCategoryDTO[];
  /** True while the first chip read is in flight. */
  loading: boolean;
  /** Apply a user correction and refresh the chips straight from the returned list. */
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

  useEffect(() => {
    currentItemIdRef.current = itemId;
    // Correction feedback is per-item — leaving the item drops both the error
    // banner and the retry target, so an alert never lingers on a memory the
    // user is no longer looking at.
    setCorrectionError(null);
    lastCorrectionRef.current = null;

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
      lastCorrectionRef.current = input;
      void api
        .applyCategoryCorrection(input)
        .then((refreshed) => {
          if (!mountedRef.current || currentItemIdRef.current !== capturedItemId) {
            return;
          }
          setCategories(refreshed);
          setCorrectionError(null);
          lastCorrectionRef.current = null;
        })
        .catch(() => {
          if (!mountedRef.current || currentItemIdRef.current !== capturedItemId) {
            return;
          }
          // Surface a calm, retryable failure — the current chips stay put
          // because nothing on disk changed.
          setCorrectionError({ message: CORRECTION_FAILURE_MESSAGE });
        });
    },
    [api],
  );

  const applyCorrection = useCallback(
    (input: CategorizationCorrectionDTO): void => {
      runCorrection(input);
    },
    [runCorrection],
  );

  const retryCorrection = useCallback((): void => {
    const previous = lastCorrectionRef.current;
    if (previous === null) {
      return;
    }
    runCorrection(previous);
  }, [runCorrection]);

  return { categories, loading, applyCorrection, correctionError, retryCorrection };
}
