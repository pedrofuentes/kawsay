// The Settings section. It moves keyboard focus to its <h1> on mount (like every
// primary view, WCAG 2.4.3 / AC-13) and hosts the opt-in consent cards — the one
// place a user reviews the on-device optional features (transcription #132, and
// smart search M4-1b), turns them on, and sees their current state. Everything
// here stays on the computer; there is nothing to sign in to. The smart-search
// card stays hidden until its model is published (offered), so pre-publish this
// view is unchanged.
import type { ReactElement } from 'react';
import { SmartSearchConsent } from '@renderer/components/SmartSearchConsent';
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
      <SmartSearchConsent />
    </section>
  );
}
