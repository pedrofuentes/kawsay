// Step 1 — Name. The single most personalising question, asked gently. Focus moves
// to the heading on entry; the name then threads through the rest of the flow.
import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { Button } from '@renderer/components/Button';
import { PathField } from '@renderer/components/PathField';
import { useAutoFocusHeading } from '@renderer/lib/use-auto-focus';
import { StepContainer } from '../StepContainer';

export interface NameStepProps {
  initialName: string;
  onContinue: (name: string) => void;
}

export function NameStep({ initialName, onContinue }: NameStepProps): ReactElement {
  const headingRef = useAutoFocusHeading();
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (trimmed.length > 0) {
      onContinue(trimmed);
    }
  };

  return (
    <StepContainer>
      <form className="flex flex-col gap-6" onSubmit={submit}>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-3xl font-semibold leading-tight text-text-primary outline-none"
        >
          Who are you honoring?
        </h1>
        <PathField
          label="Who are you honoring?"
          labelHidden
          value={name}
          onChange={setName}
          helper="We'll use their name as we go — first name is perfect."
          placeholder="Their name"
        />
        <div>
          <Button variant="primary" type="submit" disabled={trimmed.length === 0}>
            Continue
          </Button>
        </div>
      </form>
    </StepContainer>
  );
}
