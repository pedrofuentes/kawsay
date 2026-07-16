// The one `<h1>` recipe every primary view shares — the calm, focusable page
// title (font-display text-3xl font-semibold text-text-primary outline-none)
// that used to be copy-pasted at every view's top (Timeline, Search, Settings,
// ItemView, Collections — #436). Focus management stays with the caller: most
// views seed `headingRef` from `useAutoFocusHeading` (focus-on-mount), but a
// view whose focus rule is more than "on mount" — Timeline re-focuses only when
// it BECOMES the active view (#432) — owns its own ref and effect and simply
// hands the ref here.
import type { ReactElement, ReactNode, RefObject } from 'react';
import { cx } from '@renderer/lib/cx';

export interface HeadingProps {
  id?: string;
  headingRef?: RefObject<HTMLHeadingElement>;
  className?: string;
  children: ReactNode;
}

const RECIPE = 'font-display text-3xl font-semibold text-text-primary outline-none';

export function Heading({ id, headingRef, className, children }: HeadingProps): ReactElement {
  return (
    <h1 id={id} ref={headingRef} tabIndex={-1} className={cx(RECIPE, className)}>
      {children}
    </h1>
  );
}
