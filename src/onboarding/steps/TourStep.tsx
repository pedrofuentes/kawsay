// The real "Show me around first" tour (#434 remainder — the favourite toggle
// half already shipped in #453). Previously `onTour` just called `enterApp()`
// and dumped a visitor straight on an empty timeline (no library exists yet at
// this point in onboarding). This is a genuine, calm 3-card preview instead —
// the timeline, adding memories, and the standing privacy promise — matching
// USER_FLOWS' "Returning user" note: *"'Show me around first' replays a 3-card,
// skippable tour, never forced."* Skip is offered on EVERY card (never gated
// behind reaching the end), and both finishing and skipping land on the
// timeline. Each card moves focus to its own <h1> like every other onboarding
// step (§6 focus management) — this mirrors ImportStep's per-face refocus
// rather than `useAutoFocusHeading` (whose empty-deps effect only fires once
// per MOUNT, and this component stays mounted across all 3 cards).
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@renderer/components/Button';
import { Icon } from '@renderer/components/Icon';
import type { IconName } from '@renderer/components/Icon';
import { StepIndicator } from '@renderer/components/StepIndicator';
import { StepContainer } from '../StepContainer';

export interface TourStepProps {
  /** Reached the end of the tour (the 3rd card's primary action). */
  onDone: () => void;
  /** Left early — offered on every card, not just the last. */
  onSkip: () => void;
}

interface TourCard {
  icon: IconName;
  heading: string;
  body: string;
}

const CARDS: readonly TourCard[] = [
  {
    icon: 'heart',
    heading: 'The timeline is where every memory gathers',
    body:
      'Photos, voice notes, messages and more, gathered gently in one calm place, newest first. It is always here to come back to.',
  },
  {
    icon: 'archive',
    heading: "Add memories whenever you're ready",
    body:
      "Bring in a WhatsApp export, a folder of photos, or another source any time you like — there's no rush, and you can always add more later.",
  },
  {
    icon: 'lock',
    heading: 'Nothing ever leaves this computer',
    body:
      'Your memories never leave this computer. No account, no cloud, nothing is uploaded — everything stays right here, private to you.',
  },
];

const HEADING_CLASS =
  'font-display text-3xl font-semibold leading-tight text-text-primary outline-none';

export function TourStep({ onDone, onSkip }: TourStepProps): ReactElement {
  const [index, setIndex] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const card = CARDS[index];
  const isLast = index === CARDS.length - 1;

  // Re-orient focus to the new card's heading every time the tour advances —
  // this component stays mounted across all 3 cards, so a plain empty-deps
  // auto-focus hook would only fire once and strand focus on card 1.
  useEffect(() => {
    headingRef.current?.focus();
  }, [index]);

  return (
    <StepContainer>
      <StepIndicator current={index + 1} total={CARDS.length} />
      <span
        aria-hidden
        className="flex h-14 w-14 items-center justify-center rounded-full bg-sage-50 text-sage-600"
      >
        <Icon name={card.icon} className="h-7 w-7" />
      </span>
      <h1 ref={headingRef} tabIndex={-1} className={HEADING_CLASS}>
        {card.heading}
      </h1>
      <p className="font-body text-lg leading-relaxed text-text-secondary">{card.body}</p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          variant="primary"
          onClick={() => (isLast ? onDone() : setIndex((current) => current + 1))}
        >
          {isLast ? 'Take me to the timeline' : 'Next'}
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          Skip tour
        </Button>
      </div>
    </StepContainer>
  );
}
