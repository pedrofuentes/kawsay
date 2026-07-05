// Host-side cancel-flag wrapper around a {@link CategorizationLibraryPort} —
// the interim off-thread cancel path's cooperative cancel probe (M4-2h / #270),
// extracted from `electron/main/index.ts` so the start/cancel toggle lifecycle
// is unit-testable without booting Electron. The wrapper owns a single
// `cancelRequested` boolean: `start` clears it, `cancel` sets it, and the
// probe passed to the caller's port factory (typically wired into the inline
// cluster transport's `isCancelled`) reads it at each yield point.
//
// Race hardening (#377): the previous inlined wrapper unconditionally cleared
// the flag on every `start()`, so a `categorize:cancel` followed by a
// `categorize:start` serviced in the same event-loop poll — BEFORE the
// in-flight yield's pending `setImmediate` fired — flipped the flag
// `true → false`. The orchestrator's single-flight short-circuited the second
// start as `busy` without beginning a new run; the in-flight yield then read
// `false` and let the remaining themes pass run in full, burning main-thread
// CPU post-cancel. This wrapper RESTORES the flag to its prior value when
// `port.start()` resolves with `busy` (i.e. no fresh run began), keeping the
// outstanding cancel armed. A truly fresh run (any other outcome) leaves the
// flag cleared, so the next cycle starts from a clean state.

import type { CategorizationLibraryPort } from './categorization-library';

/**
 * Build a {@link CategorizationLibraryPort} whose `start`/`cancel` toggle a
 * host-owned cancel-request flag, and expose that flag to the caller's port
 * factory as an `isCancelled` probe (so the injected cluster transport can
 * consult the same flag the toggle mutates).
 *
 * The `buildPort` factory receives the probe and MUST use it when building
 * the underlying port's cluster transport — otherwise cancels have no way
 * to reach the in-flight run.
 */
export function createCancelFlaggedCategorizationPort(
  buildPort: (isCancelled: () => boolean) => CategorizationLibraryPort,
): CategorizationLibraryPort {
  let cancelRequested = false;
  const isCancelled = (): boolean => cancelRequested;
  const port = buildPort(isCancelled);

  return {
    listForItem: (itemId) => port.listForItem(itemId),
    applyCorrection: (input) => port.applyCorrection(input),
    status: () => port.status(),
    start: async () => {
      const prior = cancelRequested;
      cancelRequested = false;
      const result = await port.start();
      if (result.outcome === 'busy') {
        // A start racing an in-flight run did NOT begin a fresh run, so the
        // cancel that preceded it stays armed for the still-running transport.
        cancelRequested = prior;
      }
      return result;
    },
    cancel: () => {
      cancelRequested = true;
      return port.cancel();
    },
  };
}
