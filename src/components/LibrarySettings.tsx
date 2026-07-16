// The library-location surface (AC-13 / Journey G, #433): shows where THIS
// library lives (its name + its folder) and offers "Open another library…",
// reusing LibraryProvider's EXISTING open flow (openLibrary) — no new IPC —
// mirroring the onboarding LibraryLocationStep's own PathField + Browse pattern.
import { useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { Button } from '@renderer/components/Button';
import { ErrorBanner } from '@renderer/components/ErrorBanner';
import { PathField } from '@renderer/components/PathField';
import { useLibrary } from '@renderer/lib/library';

export function LibrarySettings(): ReactElement {
  const { library, openLibrary, status } = useLibrary();
  const [choosing, setChoosing] = useState(false);
  const [path, setPath] = useState('');
  const headingId = useId();
  const errorId = useId();
  const hasError = choosing && status === 'error';
  const busy = status === 'loading';
  const canSubmit = path.trim().length > 0 && !busy;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSubmit) return;
    const summary = await openLibrary({ path: path.trim() });
    if (summary !== null) {
      setChoosing(false);
      setPath('');
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-2xl border border-border-subtle bg-surface-raised p-6"
    >
      <h2
        id={headingId}
        className="font-display text-2xl font-semibold leading-tight text-text-primary"
      >
        Your library
      </h2>
      {library !== null ? (
        <p className="font-body text-base leading-relaxed text-text-secondary">
          {library.name}&apos;s memories live at{' '}
          <span className="font-medium text-text-primary">{library.root}</span>.
        </p>
      ) : (
        <p className="font-body text-base leading-relaxed text-text-secondary">
          No library is open right now.
        </p>
      )}
      {choosing ? (
        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <PathField
            label="Folder where the other library is"
            value={path}
            onChange={setPath}
            browseFor="directory"
            helper="Choose the Kawsay folder with Browse, or type its path."
            placeholder="e.g. Documents/Kawsay"
            invalid={hasError}
            describedBy={hasError ? errorId : undefined}
          />
          {hasError ? (
            <ErrorBanner
              id={errorId}
              message="We couldn't find a Kawsay library there. Try choosing the folder you made before."
            />
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button variant="primary" type="submit" disabled={!canSubmit}>
              Open this library
            </Button>
            <Button variant="ghost" onClick={() => setChoosing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button variant="secondary" onClick={() => setChoosing(true)}>
            Open another library…
          </Button>
        </div>
      )}
    </section>
  );
}
