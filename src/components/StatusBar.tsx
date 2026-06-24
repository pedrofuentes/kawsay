// The persistent footer. It always restates the core promise ("Private & on this
// computer") and, once a library is open, names it quietly. Rendered as a
// <footer> landmark so assistive tech can find it.
import type { ReactElement } from 'react';
import { PrivacyBadge } from './PrivacyBadge';

export interface StatusBarProps {
  libraryName?: string;
}

export function StatusBar({ libraryName }: StatusBarProps): ReactElement {
  return (
    <footer className="flex items-center justify-between gap-4 border-t border-border-subtle bg-surface-sunken px-6 py-2.5">
      <PrivacyBadge variant="status-bar" />
      {libraryName !== undefined ? (
        <span className="font-body text-sm text-text-secondary">{libraryName}</span>
      ) : null}
    </footer>
  );
}
