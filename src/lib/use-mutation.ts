// The renderer's imperative-write sibling of `useQuery` (#443/#486). Where
// `useQuery` guards a fetch-on-key READ, this guards an imperative WRITE (an
// accept/merge/dismiss curation click, a correction) with the SAME load-bearing
// race guard, factored out of the hand-rolled `runAction` latest-wins guard
// `useSuggestions` carried for the spurious-notice race (#407).
//
// The invariant is LATEST-INVOCATION-WINS: each `mutate` captures a monotonic
// generation the instant it starts, and its outcome is committed ONLY if that
// generation is still current AND the hook is still mounted AND still enabled. So
// an earlier action that resolves after a newer one — or any settle after unmount
// or after the feature was disabled — is dropped, never clobbering the newer
// outcome or resurfacing a stale error. This is a `!==` latest-wins guard (the
// generation is bumped the instant a successor starts), deliberately NOT the
// advance-only `<` successor-tracking guard `useItemCategories` keeps bespoke
// (#360/#388), which must APPLY an earlier success that lands before any later one.
//
// It stays dependency-free (ADR-0014/0015 — no react-query/swr): pure React refs.
// The error is surfaced RAW (never mapped or swallowed) so the owning hook can
// translate it, exactly like `useQuery`.
import { useCallback, useEffect, useRef, useState } from 'react';

export type MutationStatus = 'idle' | 'pending' | 'success' | 'error';

export interface UseMutationOptions<TVariables, TResult> {
  /** Runs the imperative write. Receives the caller's variables and an
   *  `AbortSignal` that fires when this mutation is superseded (a newer `mutate`,
   *  a disable, or unmount), for ops that can honour it. MUST report failure by
   *  returning a rejected promise, not by throwing synchronously. */
  mutationFn: (variables: TVariables, signal: AbortSignal) => Promise<TResult>;
  /** Default true. While false the hook is inert: `mutate` is a no-op, any
   *  in-flight mutation is superseded so its late settle never commits, and a
   *  previously surfaced error is cleared back to idle. */
  enabled?: boolean;
  /** Fires on a COMMITTED success (latest generation, still mounted & enabled) —
   *  the seam a hook uses to write the server-returned result back into its view. */
  onSuccess?: (result: TResult, variables: TVariables) => void;
  /** Fires on a COMMITTED failure (same gating). Receives the RAW rejection. */
  onError?: (error: unknown, variables: TVariables) => void;
}

export interface UseMutationResult<TVariables> {
  /** Run the mutation for `variables`. Supersedes any in-flight mutation. No-op
   *  while disabled. */
  mutate: (variables: TVariables) => void;
  /** The latest committed status. */
  status: MutationStatus;
  /** The RAW rejection from the most recent committed failure (undefined otherwise). */
  error: unknown;
  /** True while a mutation is in flight. */
  isPending: boolean;
}

interface MutationState {
  status: MutationStatus;
  error: unknown;
}

const IDLE: MutationState = { status: 'idle', error: undefined };

export function useMutation<TVariables, TResult>(
  options: UseMutationOptions<TVariables, TResult>,
): UseMutationResult<TVariables> {
  const { mutationFn, enabled = true, onSuccess, onError } = options;

  const [state, setState] = useState<MutationState>(IDLE);

  // Monotonic mutation generation. Every mutate captures the value live at start;
  // an outcome whose generation is no longer current has been superseded (a newer
  // mutate, an enable/disable toggle, or an unmount) and is dropped on settle.
  const generationRef = useRef(0);
  // False after unmount so a late settle never calls setState on a dead tree.
  const mountedRef = useRef(true);
  // The current abort controller, aborted the moment a mutation is superseded.
  const controllerRef = useRef<AbortController | null>(null);
  // Mirrors `enabled` for the async settle: an outcome that lands after the hook
  // was disabled must never commit onto an inert hook.
  const enabledRef = useRef(enabled);

  // Latest callbacks/fn in refs so `mutate` keeps a stable identity.
  const mutationFnRef = useRef(mutationFn);
  mutationFnRef.current = mutationFn;
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Supersede any in-flight mutation so its late settle is dropped, and signal
      // abort for ops that honour it.
      generationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, []);

  // Enable/disable gate. Mirrors runAction's [api, enabled] effect: every change
  // supersedes any in-flight mutation (bump the generation, abort the signal) so
  // its late settle is dropped even across a disable→re-enable while in flight,
  // and a disable clears any surfaced error back to idle (an inert hook shows no
  // lingering hint). enabledRef mirrors the flag for the settle guard above.
  useEffect(() => {
    enabledRef.current = enabled;
    generationRef.current += 1;
    controllerRef.current?.abort();
    if (!enabled) {
      setState((prev) => (prev.status === 'idle' && prev.error === undefined ? prev : IDLE));
    }
  }, [enabled]);

  const mutate = useCallback((variables: TVariables): void => {
    if (!enabledRef.current) {
      return;
    }
    // Supersede any in-flight mutation: bump the generation and abort the old signal.
    generationRef.current += 1;
    const myGeneration = generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setState((prev) => (prev.status === 'pending' ? prev : { status: 'pending', error: undefined }));

    mutationFnRef.current(variables, controller.signal).then(
      (result) => {
        if (!mountedRef.current || myGeneration !== generationRef.current || !enabledRef.current) {
          return;
        }
        setState({ status: 'success', error: undefined });
        onSuccessRef.current?.(result, variables);
      },
      (cause: unknown) => {
        if (!mountedRef.current || myGeneration !== generationRef.current || !enabledRef.current) {
          return;
        }
        // Surface the RAW cause; the owning hook maps it to copy.
        setState({ status: 'error', error: cause });
        onErrorRef.current?.(cause, variables);
      },
    );
  }, []);

  return {
    mutate,
    status: state.status,
    error: state.error,
    isPending: state.status === 'pending',
  };
}
