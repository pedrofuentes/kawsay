// The Settings section. It moves keyboard focus to its <h1> on mount (like every
// primary view, WCAG 2.4.3 / AC-13) and hosts: the accessibility controls (text
// size + reduced motion, Journey G / AC-13, #433), where the library lives (with
// an "open another library" action), the opt-in consent cards — the one place a
// user reviews the on-device optional features (transcription #132, and smart
// search M4-1b), turns them on, and sees their current state — and a privacy
// section restating that everything stays on this computer. The smart-search
// card stays hidden until its model is published (offered), so pre-publish this
// view is unchanged there.
import type { ReactElement } from 'react';
import { CategorizationConsent } from '@renderer/components/CategorizationConsent';
import { LibrarySettings } from '@renderer/components/LibrarySettings';
import { PrivacyNotice } from '@renderer/components/PrivacyNotice';
import { ReducedMotionToggle } from '@renderer/components/ReducedMotionToggle';
import { SmartSearchConsent } from '@renderer/components/SmartSearchConsent';
import { SuggestionsTray } from '@renderer/components/SuggestionsTray';
import { SystemCapabilities } from '@renderer/components/SystemCapabilities';
import { TextSizeControl } from '@renderer/components/TextSizeControl';
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
      <section
        aria-label="Reading and motion"
        className="flex flex-col gap-6 rounded-2xl border border-border-subtle bg-surface-raised p-6"
      >
        <TextSizeControl />
        <ReducedMotionToggle />
      </section>
      <LibrarySettings />
      <SystemCapabilities />
      <TranscriptionConsent />
      <TranscriptionRun />
      <SmartSearchConsent />
      <CategorizationConsent />
      <SuggestionsTray />
      <PrivacyNotice />
      <footer className="font-body text-sm text-text-secondary">
        Place names © GeoNames, licensed under CC BY 4.0.
      </footer>
    </section>
  );
}
