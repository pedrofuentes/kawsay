// Gentle micro-copy that reassures the user mid-task (e.g. "we're only making a
// copy"). Kept as its own component so the calm tone and spacing stay consistent
// wherever reassurance is needed.
import type { ReactElement, ReactNode } from 'react';

export interface ReassuranceNoteProps {
  children: ReactNode;
  tone?: 'info' | 'privacy' | 'pacing';
}

export function ReassuranceNote({ children, tone = 'info' }: ReassuranceNoteProps): ReactElement {
  return (
    <p data-tone={tone} className="font-body text-base leading-relaxed text-text-secondary">
      {children}
    </p>
  );
}
