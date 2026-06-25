// A labelled text field for a file or folder path (and reused for the loved one's
// name). The path can be typed or pasted, and — when running inside the app
// (a `kawsayAPI` bridge is present) and `browseFor` is set — an accessible
// "Browse…" button opens the matching native picker (W2) and fills the field with
// the chosen path. Typing always remains a fallback; in a plain browser preview
// (no bridge) the button simply isn't shown. The label is always associated with
// the input (optionally visually hidden when a nearby heading already names it).
import { useId } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import { Button } from '@renderer/components/Button';
import { useKawsayApi } from '@renderer/lib/kawsay-api';

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
  /**
   * When set, render a native "Browse…" button that opens the folder
   * (`directory`) or single-file (`file`) picker and fills the field. Omit it for
   * non-path fields (e.g. the name) so no button appears.
   */
  browseFor?: 'directory' | 'file';
  /** Accessible name + native dialog title for the Browse button (defaults to the label). */
  browseTitle?: string;
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
  browseFor,
  browseTitle,
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

  // The native picker runs entirely in the main process; the renderer only learns
  // the single path the user chose. Outside Electron (browser preview) there is no
  // bridge, so the Browse affordance is omitted and typing remains the way in.
  const api = useKawsayApi();
  const canBrowse = browseFor !== undefined && api !== undefined;

  const handleBrowse = async (): Promise<void> => {
    if (api === undefined || browseFor === undefined) {
      return;
    }
    const title = browseTitle ?? label;
    const options = {
      title: title !== '' ? title : undefined,
      defaultPath: value !== '' ? value : undefined,
    };
    const picked =
      browseFor === 'file' ? await api.openFile(options) : await api.openDirectory(options);
    // A cancelled picker resolves null (and an empty string is never a real path),
    // so the field is left exactly as the user had it.
    if (picked !== null && picked !== '') {
      onChange(picked);
    }
  };

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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        <input
          id={inputId}
          type="text"
          value={value}
          placeholder={placeholder}
          aria-describedby={describedByIds === '' ? undefined : describedByIds}
          aria-invalid={invalid ? true : undefined}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          className="min-h-12 flex-1 rounded-lg border border-border-interactive bg-surface-raised px-4 font-body text-base text-text-primary placeholder:text-text-secondary"
        />
        {canBrowse ? (
          <Button variant="secondary" onClick={() => void handleBrowse()}>
            Browse…
          </Button>
        ) : null}
      </div>
    </div>
  );
}
