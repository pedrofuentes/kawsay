// Moves keyboard focus to a step's heading when that step mounts. Each onboarding
// step owns an <h1 tabIndex={-1}> so screen-reader and keyboard users are
// re-oriented to the new screen instead of being stranded on a stale control
// (USER_FLOWS §6 focus management).
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

export function useAutoFocusHeading<T extends HTMLElement = HTMLHeadingElement>(): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}
