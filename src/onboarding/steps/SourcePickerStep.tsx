// Step 3 — Choose a source (AC-12). A short, calm menu of the places memories
// commonly live, plus a no-pressure escape hatch into the app. Picking a card
// leads into that source's gentle export walkthrough.
import type { ReactElement } from 'react';
import { Button } from '@renderer/components/Button';
import { SourceCard } from '@renderer/components/SourceCard';
import { useAutoFocusHeading } from '@renderer/lib/use-auto-focus';
import { StepContainer } from '../StepContainer';
import { SOURCES } from '../sources';
import type { SourceMeta } from '../sources';

export interface SourcePickerStepProps {
  personName: string;
  onBack: () => void;
  onPick: (source: SourceMeta) => void;
  onSkip: () => void;
}

export function SourcePickerStep({
  personName,
  onBack,
  onPick,
  onSkip,
}: SourcePickerStepProps): ReactElement {
  const headingRef = useAutoFocusHeading();

  return (
    <StepContainer>
      <Button variant="ghost" onClick={onBack}>
        Go back
      </Button>
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="font-display text-3xl font-semibold leading-tight text-text-primary outline-none"
      >
        Where are some of {personName}&apos;s memories?
      </h1>
      <p className="font-body text-lg leading-relaxed text-text-secondary">
        Pick wherever feels easiest to start. You can always bring in more later.
      </p>
      <ul className="flex flex-col gap-3">
        {SOURCES.map((source) => (
          <li key={source.type}>
            <SourceCard
              title={source.title}
              description={source.description}
              icon={source.icon}
              onSelect={() => onPick(source)}
            />
          </li>
        ))}
      </ul>
      <div>
        <Button variant="ghost" onClick={onSkip}>
          I&apos;ll add this later
        </Button>
      </div>
    </StepContainer>
  );
}
