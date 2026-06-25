// Whether the user prefers reduced motion. Reduced motion is Kawsay's DEFAULT
// posture (USER_FLOWS §5.6, rubric R11): when we cannot positively detect that
// motion is welcome — `matchMedia` missing (jsdom, a constrained webview) — we
// assume reduced and skip non-essential animation. Components use this to decide
// whether to apply a gentle fade, while the global CSS media query is the backstop.
import { useEffect, useState } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function readReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** React hook: `true` when motion should be minimised (the calm default). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(readReducedMotion);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (): void => setReduced(query.matches);
    onChange();
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);

  return reduced;
}
