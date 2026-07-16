// Whether motion should be minimised. Reduced motion is Kawsay's DEFAULT posture
// (USER_FLOWS §5.6, rubric R11): when we cannot positively detect that motion is
// welcome — `matchMedia` missing (jsdom, a constrained webview) — we assume
// reduced and skip non-essential animation. Components use this to decide
// whether to apply a gentle fade, while the global CSS media query is the
// backstop.
//
// AC-13 / Journey G (#433) adds an explicit IN-APP override (the Settings
// "Reduce motion" toggle): when it is ON, motion is reduced regardless of the
// OS setting; when OFF/unset, this composes with — never suppresses — the OS
// query below. `src/lib/settings.tsx` maintains the override as a root
// attribute (`<html data-reduced-motion="on|off">`) rather than threading a
// context through this hook, so it keeps working standalone (e.g. in a test
// with no SettingsProvider) and stays decoupled from React context wiring.
import { useEffect, useState } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Fired whenever the in-app override (Settings, #433) changes, so every live
 *  `usePrefersReducedMotion` subscriber recomputes immediately. */
export const REDUCED_MOTION_OVERRIDE_EVENT = 'kawsay:reduced-motion-change';

function readOsReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** Whether the explicit in-app override is ON — reads the root attribute
 *  `src/lib/settings.tsx` maintains. Absent/`'off'` defers entirely to the OS
 *  query above (the override can only ever ADD caution, never suppress it). */
function readOverride(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.dataset.reducedMotion === 'on';
}

function readReducedMotion(): boolean {
  return readOsReducedMotion() || readOverride();
}

/** React hook: `true` when motion should be minimised — the OS `prefers-reduced-
 *  motion` query OR the explicit in-app override, whichever asks for LESS motion. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(readReducedMotion);

  useEffect(() => {
    const recompute = (): void => setReduced(readReducedMotion());
    recompute();
    if (typeof window === 'undefined') return;
    const query = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION_QUERY) : undefined;
    query?.addEventListener?.('change', recompute);
    window.addEventListener(REDUCED_MOTION_OVERRIDE_EVENT, recompute);
    return () => {
      query?.removeEventListener?.('change', recompute);
      window.removeEventListener(REDUCED_MOTION_OVERRIDE_EVENT, recompute);
    };
  }, []);

  return reduced;
}
