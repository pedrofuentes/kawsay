// The application shell: a single <main> landmark with the persistent privacy
// status bar beneath it. The `onboarding` variant is a quiet, centered, single-
// column canvas; the `main` variant adds the primary navigation sidebar for the
// timeline / search / settings screens that U1 and U2 will build inside it.
import type { ReactElement, ReactNode } from 'react';
import { StatusBar } from './StatusBar';

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
      <div className="flex flex-1 overflow-hidden">
        {variant === 'main' && sidebar !== undefined ? (
          <aside
            aria-label="Sections"
            className="w-64 shrink-0 border-r border-border-subtle bg-surface-tinted"
          >
            {sidebar}
          </aside>
        ) : null}
        <main
          className={
            variant === 'onboarding'
              ? 'flex flex-1 items-center justify-center overflow-y-auto px-6 py-10'
              : 'flex-1 overflow-y-auto px-8 py-8'
          }
        >
          {children}
        </main>
      </div>
      <StatusBar libraryName={libraryName} />
    </div>
  );
}
