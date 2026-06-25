// Step 4b — Point at the saved file or folder ("Step 2 of 2" of the source flow).
// We only ever copy from here; the reassurance says so plainly. The path can be
// chosen with the native picker (Browse…) — a file or folder picker depending on
// the source — or typed/pasted as a fallback.
import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { Button } from '@renderer/components/Button';
import { PathField } from '@renderer/components/PathField';
import { ReassuranceNote } from '@renderer/components/ReassuranceNote';
import { StepIndicator } from '@renderer/components/StepIndicator';
import { useAutoFocusHeading } from '@renderer/lib/use-auto-focus';
import { StepContainer } from '../StepContainer';
import type { SourceMeta } from '../sources';

export interface ImportLocateStepProps {
  source: SourceMeta;
  personName: string;
  onBack: () => void;
  onStart: (inputPath: string) => void;
}

export function ImportLocateStep({
  source,
  personName,
  onBack,
  onStart,
}: ImportLocateStepProps): ReactElement {
  const headingRef = useAutoFocusHeading();
  const [path, setPath] = useState('');
  const canSubmit = path.trim().length > 0;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (canSubmit) {
      onStart(path.trim());
    }
  };

  return (
    <StepContainer>
      <Button variant="ghost" onClick={onBack}>
        Go back
      </Button>
      <StepIndicator current={2} total={2} />
      <form className="flex flex-col gap-6" onSubmit={submit}>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-3xl font-semibold leading-tight text-text-primary outline-none"
        >
          {source.pickerKind === 'file' ? 'Where is the file you saved?' : 'Which folder should we look in?'}
        </h1>
        <ReassuranceNote tone="privacy">{source.reassurance}</ReassuranceNote>
        <PathField
          label={source.locateLabel}
          value={path}
          onChange={setPath}
          browseFor={source.pickerKind === 'file' ? 'file' : 'directory'}
          helper={source.locateHelper}
          placeholder={source.locatePlaceholder}
        />
        <div>
          <Button variant="primary" type="submit" disabled={!canSubmit}>
            Bring {personName}&apos;s memories in
          </Button>
        </div>
      </form>
    </StepContainer>
  );
}
