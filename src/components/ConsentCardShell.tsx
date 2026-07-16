// The shared "face-machine" shell the two opt-in consent cards (SmartSearchConsent,
// TranscriptionConsent) both build on (#436): an icon + heading + subtitle intro,
// one global on/off switch reflecting + controlling the feature's current state,
// and a slot beneath for the caller's own checking/intro/downloading/error/ready
// face. Each card keeps its own hook, copy, state machine and face content —
// only this outer frame (and its exact markup) is shared, so the two stay
// deliberately independent in voice while never drifting apart in structure.
import type { ReactElement, ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { cx } from '@renderer/lib/cx';

export interface ConsentCardShellProps {
  headingId: string;
  icon: IconName;
  title: string;
  subtitle: string;
  switchLabelId: string;
  switchStatusId: string;
  switchLabel: string;
  switchStatus: string;
  /** Is the feature currently ON (model ready AND the person's toggle is on)? */
  on: boolean;
  /** The switch stays disabled until the model is present + verified (the gate). */
  switchDisabled: boolean;
  onToggle: () => void;
  /** The caller's current face (checking/intro/downloading/error/ready). */
  children: ReactNode;
}

export function ConsentCardShell({
  headingId,
  icon,
  title,
  subtitle,
  switchLabelId,
  switchStatusId,
  switchLabel,
  switchStatus,
  on,
  switchDisabled,
  onToggle,
  children,
}: ConsentCardShellProps): ReactElement {
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-6 rounded-2xl border border-border-subtle bg-surface-raised p-6"
    >
      <div className="flex items-start gap-4">
        <span
          aria-hidden
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-sage-50 text-sage-600"
        >
          <Icon name={icon} className="h-6 w-6" />
        </span>
        <div className="flex flex-col gap-1">
          <h2
            id={headingId}
            className="font-display text-2xl font-semibold leading-tight text-text-primary"
          >
            {title}
          </h2>
          <p className="font-body text-base text-text-secondary">{subtitle}</p>
        </div>
      </div>

      {/* The single global toggle: the state is always visible, and it stays
          disabled until the model is present + verified (the gate). */}
      <div className="flex items-center justify-between gap-4 rounded-xl bg-surface-sunken px-4 py-3">
        <div className="flex flex-col">
          <span id={switchLabelId} className="font-body text-base font-medium text-text-primary">
            {switchLabel}
          </span>
          <span id={switchStatusId} className="font-body text-sm text-text-secondary">
            {switchStatus}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={switchLabelId}
          aria-describedby={switchStatusId}
          disabled={switchDisabled}
          onClick={onToggle}
          className={cx(
            'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-55',
            on ? 'bg-sage-600' : 'bg-border-interactive',
          )}
        >
          <span
            aria-hidden
            className={cx(
              'inline-block h-5 w-5 rounded-full bg-surface-raised transition-transform duration-150',
              on ? 'translate-x-6' : 'translate-x-1',
            )}
          />
        </button>
      </div>

      {children}
    </section>
  );
}
