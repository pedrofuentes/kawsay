// Step 0 — Welcome. Leads with warmth and the core promise before asking for
// anything. Two unhurried choices: begin, or take a gentle tour first. This is
// the only step that does not pull focus to its heading (it's the first screen,
// so the natural document start is fine).
import type { ReactElement } from 'react';
import { BrandMark } from '@renderer/components/BrandMark';
import { Button } from '@renderer/components/Button';
import { StepContainer } from '../StepContainer';

export interface WelcomeStepProps {
  onStart: () => void;
  onTour: () => void;
}

export function WelcomeStep({ onStart, onTour }: WelcomeStepProps): ReactElement {
  return (
    <StepContainer>
      <span
        aria-hidden
        className="flex h-16 w-16 items-center justify-center rounded-full bg-clay-100 text-brand"
      >
        <BrandMark className="h-9 w-auto" />
      </span>
      <h1 className="font-display text-4xl font-semibold leading-tight text-text-primary">
        A calm place to gather the memories of someone you love.
      </h1>
      <p className="font-body text-lg leading-relaxed text-text-secondary">
        Take your time. We&apos;ll go one gentle step at a time, and you can stop or come back
        whenever you need to.
      </p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button variant="primary" onClick={onStart}>
          Start bringing memories
        </Button>
        <Button variant="ghost" onClick={onTour}>
          Show me around first
        </Button>
      </div>
    </StepContainer>
  );
}
