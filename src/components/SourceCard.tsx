// A large, calm, selectable card for picking an import source. The whole card is
// one button so the entire target is clickable and keyboard-focusable; its
// accessible name is the title + plain-language description.
import type { ReactElement, ReactNode } from 'react';

export interface SourceCardProps {
  title: string;
  description: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

export function SourceCard({
  title,
  description,
  icon,
  onSelect,
  disabled = false,
}: SourceCardProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      data-variant="source"
      className="flex min-h-20 w-full items-center gap-4 rounded-lg border border-border-interactive bg-surface-raised p-5 text-left transition-colors duration-150 hover:bg-surface-tinted disabled:cursor-not-allowed disabled:opacity-55"
    >
      {icon !== undefined ? (
        <span
          aria-hidden
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-sage-50 text-sage-600"
        >
          {icon}
        </span>
      ) : null}
      <span className="flex flex-col gap-1">
        <span className="font-display text-lg text-text-primary">{title}</span>
        <span className="font-body text-base text-text-secondary">{description}</span>
      </span>
    </button>
  );
}
