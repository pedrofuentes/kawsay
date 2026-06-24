// The application shell: a single <main> landmark with the persistent privacy
// status bar beneath it. The `onboarding` variant is a quiet, centered, single-
// column canvas; the `main` variant adds the primary navigation sidebar for the
// timeline / search / settings screens that U1 and U2 build inside it.
//
// A skip-to-content link is the first focusable element on every screen (WCAG
// 2.4.1, AC-13): keyboard and switch users can jump past the sidebar straight to
// the <main> landmark, which is a programmatic focus target (`tabIndex={-1}`).
import type { ReactElement, ReactNode } from 'react';
import { StatusBar } from './StatusBar';

/** Id of the <main> landmark — the skip link's target and the page focus anchor. */
const MAIN_CONTENT_ID = 'main-content';

export interface AppShellProps {
  variant?: 'onboarding' | 'main';
  sidebar?: ReactNode;
  libraryName?: string;
  children: ReactNode;
}

export function AppShell({
  variant = 'onboarding',
  sidebar,
  libraryName,
  children,
}: AppShellProps): ReactElement {
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-text-primary">
      <a href={`#${MAIN_CONTENT_ID}`} className="skip-link">
        Skip to content
      </a>
      <div className="flex flex-1 overflow-hidden">
        {variant === 'main' && sidebar !== undefined ? (
          <aside
            aria-label="Sidebar"
            className="w-64 shrink-0 border-r border-border-subtle bg-surface-tinted"
          >
            {sidebar}
          </aside>
        ) : null}
        <main
          id={MAIN_CONTENT_ID}
          tabIndex={-1}
          className={
            variant === 'onboarding'
              ? 'flex flex-1 items-center justify-center overflow-y-auto px-6 py-10 outline-none'
              : 'flex-1 overflow-y-auto px-8 py-8 outline-none'
          }
        >
          {children}
        </main>
      </div>
      <StatusBar libraryName={libraryName} />
    </div>
  );
}
