// The text-size control (AC-13 / Journey G, #433): three reverent, plain-
// language steps — Default / Large / Larger — mapped to the `--text-scale`
// token multiplier (tokens.css), applied to the WHOLE app the instant a step
// is chosen (src/lib/settings.tsx sets the root override) and persisted
// durably via the `settings:set` channel so the choice survives a relaunch.
// Native radio inputs (not a custom ARIA widget) keep this axe-clean and
// screen-reader-familiar for free; each label is a ≥44px tap target.
import { useId } from 'react';
import type { ReactElement } from 'react';
import { cx } from '@renderer/lib/cx';
import { useSettings } from '@renderer/lib/settings';
import type { TextSizeDTO } from '@shared/kawsay-api';

const STEPS: ReadonlyArray<{ value: TextSizeDTO; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' },
  { value: 'larger', label: 'Larger' },
];

export function TextSizeControl(): ReactElement {
  const { settings, setTextSize } = useSettings();
  const nameId = useId();

  return (
    <fieldset className="flex flex-col gap-3 border-0 p-0">
      <legend className="font-body text-base font-medium text-text-primary">Text size</legend>
      <div className="flex flex-col gap-3 sm:flex-row">
        {STEPS.map((step) => {
          const inputId = `${nameId}-${step.value}`;
          const checked = settings.textSize === step.value;
          return (
            <label
              key={step.value}
              htmlFor={inputId}
              className={cx(
                'flex min-h-12 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border px-4 font-body text-base transition-colors duration-150',
                checked
                  ? 'border-sage-600 bg-sage-50 text-sage-700'
                  : 'border-border-interactive bg-surface-raised text-text-primary hover:bg-surface-tinted',
              )}
            >
              <input
                id={inputId}
                type="radio"
                name={nameId}
                value={step.value}
                checked={checked}
                onChange={() => setTextSize(step.value)}
                className="h-5 w-5 accent-sage-600"
              />
              {step.label}
            </label>
          );
        })}
      </div>
      <p className="font-body text-sm text-text-secondary">
        Changes everywhere in Kawsay right away, and stays this way next time you open it.
      </p>
    </fieldset>
  );
}
