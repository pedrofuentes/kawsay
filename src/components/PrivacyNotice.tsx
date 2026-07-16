// The about/privacy section (AC-13 / Journey G, #433) restating Kawsay's core
// promise (P4) in the Settings view — the one place a grieving user might go
// looking for reassurance that nothing here is being watched or shared.
import { useId } from 'react';
import type { ReactElement } from 'react';

export function PrivacyNotice(): ReactElement {
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-2xl border border-border-subtle bg-surface-raised p-6"
    >
      <h2
        id={headingId}
        className="font-display text-2xl font-semibold leading-tight text-text-primary"
      >
        Privacy
      </h2>
      <p className="font-body text-base leading-relaxed text-text-secondary">
        Your memories never leave this computer. Everything Kawsay does — reading, organizing,
        searching — happens right here. There is no account, nothing is ever uploaded, and nothing
        is sent anywhere else.
      </p>
    </section>
  );
}
