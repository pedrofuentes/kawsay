// The Settings section. It moves keyboard focus to its <h1> on mount (like every
// primary view, WCAG 2.4.3 / AC-13) and hosts the opt-in transcription consent
// card (#132) — the one place a user reviews the on-device transcription feature,
// turns it on, and sees its current state. Everything here stays on the computer;
// there is nothing to sign in to.
import type { ReactElement } from 'react';
import { TranscriptionConsent } from '@renderer/components/TranscriptionConsent';
import { TranscriptionRun } from '@renderer/components/TranscriptionRun';
import { useAutoFocusHeading } from '@renderer/lib/use-auto-focus';

export function Settings(): ReactElement {
  const headingRef = useAutoFocusHeading<HTMLHeadingElement>();
  return (
    <section className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-3xl font-semibold text-text-primary outline-none"
        >
          Settings
        </h1>
        <p className="font-body text-base text-text-secondary">
          Everything stays on this computer. There is nothing to sign in to.
        </p>
      </header>
      <TranscriptionConsent />
      <TranscriptionRun />
    </section>
  );
}
