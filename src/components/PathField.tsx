// A labelled text field for a file or folder path (and reused for the loved one's
// name). There is no native picker over the typed bridge yet, so the user types or
// pastes a path; helper copy guides them. The label is always associated with the
// input (optionally visually hidden when a nearby heading already names it).
import { useId } from 'react';
import type { ChangeEvent, ReactElement } from 'react';

export interface PathFieldProps {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  helper?: string;
  placeholder?: string;
  labelHidden?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

export function PathField({
  id,
  label,
  value,
  onChange,
  helper,
  placeholder,
  labelHidden = false,
  invalid = false,
  describedBy,
}: PathFieldProps): ReactElement {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const helperId = helper !== undefined ? `${inputId}-helper` : undefined;
  // Associate the input with both its static helper copy and any active error
  // message (LibraryLocationStep passes the ErrorBanner id when status is error),
  // so screen readers announce the failure when focus lands on the field.
  const describedByIds = [helperId, describedBy]
    .filter((token): token is string => token !== undefined && token !== '')
    .join(' ');

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={inputId}
        className={
          labelHidden ? 'sr-only' : 'font-body text-base font-medium text-text-primary'
        }
      >
        {label}
      </label>
      {helper !== undefined ? (
        <p id={helperId} className="font-body text-sm text-text-secondary">
          {helper}
        </p>
      ) : null}
      <input
        id={inputId}
        type="text"
        value={value}
        placeholder={placeholder}
        aria-describedby={describedByIds === '' ? undefined : describedByIds}
        aria-invalid={invalid ? true : undefined}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        className="min-h-12 rounded-lg border border-border-interactive bg-surface-raised px-4 font-body text-base text-text-primary placeholder:text-text-secondary"
      />
    </div>
  );
}
