// Step 2 — Where the library lives. The user either creates a fresh library or
// opens one they made before. Failures are shown in plain language only; the raw
// OS/Node error (EACCES, ENOENT…) is never surfaced.
import { useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { Button } from '@renderer/components/Button';
import { ErrorBanner } from '@renderer/components/ErrorBanner';
import { PathField } from '@renderer/components/PathField';
import { useLibrary } from '@renderer/lib/library';
import { useAutoFocusHeading } from '@renderer/lib/use-auto-focus';
import { StepContainer } from '../StepContainer';

export interface LibraryLocationStepProps {
  personName: string;
  onBack: () => void;
  onReady: () => void;
}

type Mode = 'create' | 'open';

export function LibraryLocationStep({
  personName,
  onBack,
  onReady,
}: LibraryLocationStepProps): ReactElement {
  const headingRef = useAutoFocusHeading();
  const { createLibrary, openLibrary, status } = useLibrary();
  const [mode, setMode] = useState<Mode>('create');
  const [path, setPath] = useState('');
  const errorId = useId();
  const hasError = status === 'error';

  const busy = status === 'loading';
  const canSubmit = path.trim().length > 0 && !busy;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    const summary =
      mode === 'create'
        ? await createLibrary({ path: path.trim(), personName })
        : await openLibrary({ path: path.trim() });
    if (summary !== null) {
      onReady();
    }
  };

  const heading =
    mode === 'create'
      ? `Where should we keep ${personName}'s memories?`
      : `Where is ${personName}'s library?`;

  return (
    <StepContainer>
      <Button variant="ghost" onClick={onBack}>
        Go back
      </Button>
      <form className="flex flex-col gap-6" onSubmit={submit}>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-3xl font-semibold leading-tight text-text-primary outline-none"
        >
          {heading}
        </h1>
        <p className="font-body text-lg leading-relaxed text-text-secondary">
          {mode === 'create'
            ? 'Kawsay keeps everything in one private folder on this computer. You can choose where it lives — and move it later if you like.'
            : 'Choose the Kawsay folder you made before, and we will pick up right where you left off.'}
        </p>
        <PathField
          label={
            mode === 'create'
              ? `Folder for ${personName}'s memories`
              : `Folder where ${personName}'s library is`
          }
          value={path}
          onChange={setPath}
          browseFor="directory"
          helper={
            mode === 'create'
              ? 'Choose a folder with Browse, or type a path. Nothing leaves your computer.'
              : 'Choose your Kawsay folder with Browse, or type its path.'
          }
          placeholder="e.g. Documents/Kawsay"
          invalid={hasError}
          describedBy={hasError ? errorId : undefined}
        />
        {hasError ? (
          <ErrorBanner
            id={errorId}
            message={
              mode === 'create'
                ? "We couldn't make a library in that folder. Try another place, like your Documents folder."
                : "We couldn't find a Kawsay library there. Try choosing the folder you made before."
            }
          />
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button variant="primary" type="submit" disabled={!canSubmit}>
            {mode === 'create' ? `Create ${personName}'s library` : 'Open this library'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setMode((current) => (current === 'create' ? 'open' : 'create'))}
          >
            {mode === 'create' ? 'Open a library I already made' : 'Start a new library instead'}
          </Button>
        </div>
      </form>
    </StepContainer>
  );
}
