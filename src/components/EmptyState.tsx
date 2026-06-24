// A warm empty state: a heading, an optional line of orientation, and at most one
// next action (USER_FLOWS rubric R3 — never a wall of choices on an empty screen).
import type { ReactElement, ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps): ReactElement {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      {icon !== undefined ? (
        <span
          aria-hidden
          className="flex h-16 w-16 items-center justify-center rounded-full bg-sage-50 text-sage-600"
        >
          {icon}
        </span>
      ) : null}
      <h2 className="font-display text-2xl text-text-primary">{title}</h2>
      {description !== undefined ? (
        <p className="max-w-prose font-body text-base text-text-secondary">{description}</p>
      ) : null}
      {action !== undefined ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
