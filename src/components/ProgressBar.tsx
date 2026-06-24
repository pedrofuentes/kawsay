// An accessible progress bar. The visual fill is driven by an inline width (the
// only place we use an inline style — the CSP allows style-src-attr 'unsafe-inline'
// while forbidding inline <style> blocks). `value` is whatever the caller wants
// announced via aria-valuenow (e.g. a percentage); `valueText` gives a friendly
// spoken form.
import type { ReactElement } from 'react';

export interface ProgressBarProps {
  value: number;
  max?: number;
  label?: string;
  valueText?: string;
}

export function ProgressBar({ value, max = 100, label, valueText }: ProgressBarProps): ReactElement {
  const fraction = max > 0 ? value / max : 0;
  const pct = Math.min(100, Math.max(0, fraction * 100));
  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuetext={valueText}
      aria-label={label}
      className="h-3 w-full overflow-hidden rounded-full bg-surface-sunken"
    >
      <div
        className="h-full rounded-full bg-sage-600 transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
