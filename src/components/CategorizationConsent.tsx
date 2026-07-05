// The opt-in CATEGORIZATION consent card (M4-2h / ADR-0030). It mirrors the
// smart-search and transcription cards: a gentle screen that explains organizing a
// loved one's memories by PLACE and THEME, and ASKS before anything is grouped.
// Nothing here organizes on its own — the one global toggle is the only thing that
// flips the durable opt-in, and while it is off NO chips show and no category
// status ever transitions (default-off, AC-33).
//
// Visibility gate: the whole card stays HIDDEN until categorization is `offered`
// (the gazetteer place-name asset is bundled). `offered` flips true purely from the
// bundled asset being present — auto-revealing this card with NO code change here —
// so without the asset the user never sees a surface that can't do anything.
//
// Everything happens on this computer: there is no account and nothing is ever
// uploaded, exactly like every other Kawsay feature.
import { useId } from 'react';
import type { ReactElement } from 'react';
import { cx } from '@renderer/lib/cx';
import { Icon } from './Icon';
import { useCategorizationStatus } from '@renderer/lib/use-categorization';

export function CategorizationConsent(): ReactElement | null {
  const { offered, optedIn, loading, setOptedIn } = useCategorizationStatus();

  const headingId = useId();
  const switchLabelId = useId();
  const switchStatusId = useId();

  // Stay quiet while the first status read resolves, then hide entirely until the
  // gazetteer asset is bundled (offered). Either way the user sees nothing yet.
  if (loading || !offered) {
    return null;
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-6 rounded-2xl border border-border-subtle bg-surface-raised p-6"
    >
      <div className="flex items-start gap-4">
        <span
          aria-hidden
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-sage-50 text-sage-600"
        >
          <Icon name="globe" className="h-6 w-6" />
        </span>
        <div className="flex flex-col gap-1">
          <h2
            id={headingId}
            className="font-display text-2xl font-semibold leading-tight text-text-primary"
          >
            Organize memories by place and theme
          </h2>
          <p className="font-body text-base text-text-secondary">
            On-device organizing — entirely optional, and off until you choose it.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl bg-surface-sunken px-4 py-3">
        <div className="flex flex-col">
          <span id={switchLabelId} className="font-body text-base font-medium text-text-primary">
            Organize by place and theme
          </span>
          <span id={switchStatusId} className="font-body text-sm text-text-secondary">
            {optedIn
              ? 'On. Kawsay can gently group memories by where and what they are — always on this computer.'
              : 'Off. You can turn this on whenever you like.'}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={optedIn}
          aria-labelledby={switchLabelId}
          aria-describedby={switchStatusId}
          onClick={() => setOptedIn(!optedIn)}
          className={cx(
            'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-150',
            optedIn ? 'bg-sage-600' : 'bg-border-interactive',
          )}
        >
          <span
            aria-hidden
            className={cx(
              'inline-block h-5 w-5 rounded-full bg-surface-raised transition-transform duration-150',
              optedIn ? 'translate-x-6' : 'translate-x-1',
            )}
          />
        </button>
      </div>

      <div className="flex flex-col gap-4">
        <p className="font-body text-base leading-relaxed text-text-primary">
          Kawsay can gently gather a loved one&apos;s memories into places they were taken and
          themes they share — so you can wander through them the way you remember them, not just by
          date.
        </p>
        <p className="font-body text-base leading-relaxed text-text-secondary">
          It all happens here, on this computer. A loved one&apos;s memories never leave this
          computer — there&apos;s no account, and nothing is ever uploaded.
        </p>
        <p className="font-body text-base leading-relaxed text-text-secondary">
          Nothing is organized until you turn this on, and you can turn it off again whenever you
          like. Anything you&apos;ve confirmed or renamed stays exactly as you left it.
        </p>
      </div>
    </section>
  );
}
