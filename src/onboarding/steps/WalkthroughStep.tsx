// Step 4 — Guided "how to export" walkthrough (AC-12). For export-based sources we
// lay out the whole recipe at once, in plain steps, so the user can follow along on
// another device without losing their place. The folder source shows a one-screen
// primer instead. This is the first half of the source mini-flow ("Step 1 of 2");
// pointing at the saved file/folder is the second.
import type { ReactElement } from 'react';
import { Button } from '@renderer/components/Button';
import { StepIndicator } from '@renderer/components/StepIndicator';
import { useAutoFocusHeading } from '@renderer/lib/use-auto-focus';
import { StepContainer } from '../StepContainer';
import { withName } from '../sources';
import type { SourceMeta } from '../sources';

export interface WalkthroughStepProps {
  source: SourceMeta;
  personName: string;
  onBack: () => void;
  onDone: () => void;
}

export function WalkthroughStep({
  source,
  personName,
  onBack,
  onDone,
}: WalkthroughStepProps): ReactElement {
  const headingRef = useAutoFocusHeading();
  const isPrimer = source.steps.length === 0 && source.primer !== undefined;

  return (
    <StepContainer>
      <Button variant="ghost" onClick={onBack}>
        Go back
      </Button>
      <StepIndicator current={1} total={2} />
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="font-display text-3xl font-semibold leading-tight text-text-primary outline-none"
      >
        {withName(source.walkthroughHeading, personName)}
      </h1>
      {isPrimer ? (
        <p className="font-body text-lg leading-relaxed text-text-secondary">
          {withName(source.primer ?? '', personName)}
        </p>
      ) : (
        <ol className="flex flex-col gap-4">
          {source.steps.map((step, index) => (
            <li key={step} className="flex gap-4">
              <span
                aria-hidden
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sage-50 font-body text-base font-semibold text-sage-600"
              >
                {index + 1}
              </span>
              <span className="font-body text-base leading-relaxed text-text-primary">
                {withName(step, personName)}
              </span>
            </li>
          ))}
        </ol>
      )}
      <div>
        <Button variant="primary" onClick={onDone}>
          I&apos;ve done this
        </Button>
      </div>
    </StepContainer>
  );
}
