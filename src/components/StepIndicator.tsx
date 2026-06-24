// "Step X of N" wayfinding for multi-screen flows. The text carries the meaning
// for assistive tech; the dots are a calm visual echo and are hidden from it.
import type { ReactElement } from 'react';
import { cx } from '@renderer/lib/cx';

export interface StepIndicatorProps {
  current: number;
  total: number;
}

export function StepIndicator({ current, total }: StepIndicatorProps): ReactElement {
  return (
    <div className="flex items-center gap-3">
      <p className="font-body text-sm font-medium uppercase tracking-wide text-text-secondary">
        Step {current} of {total}
      </p>
      <span aria-hidden className="flex items-center gap-1.5">
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            className={cx(
              'h-1.5 w-1.5 rounded-full',
              index < current ? 'bg-sage-600' : 'bg-border-default',
            )}
          />
        ))}
      </span>
    </div>
  );
}
