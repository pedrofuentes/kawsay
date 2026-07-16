// The post-import "changed your mind?" affordance (#429, AC-14 / P4b). Every import
// is undoable, and this is where a user does it — right on the completion summary,
// while the choice is fresh. Removing memories is irreversible-feeling, so the action
// is CONFIRM-GATED: the first press only ASKS, a second, explicit confirmation stands
// between the user and the removal, and either way the copy stays plain and reverent
// (USER_FLOWS §1) — no code, no counts of database rows, no source ids. Nothing is
// removed until that second confirm; then `onUndo` runs and a gentle status confirms
// the library is as it was.
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';

export interface UndoBannerProps {
  /** The loved one whose library this is — named, never "your loved one". */
  personName: string;
  /** How many memories this import brought in (for the plain-language confirm copy). */
  count: number;
  /** Perform the removal. Called ONCE, and only after the second confirmation. */
  onUndo: () => Promise<void>;
}

type Phase = 'idle' | 'confirming' | 'removing' | 'removed';

export function UndoBanner({ personName, count, onUndo }: UndoBannerProps): ReactElement {
  const [phase, setPhase] = useState<Phase>('idle');
  const confirmHeadingRef = useRef<HTMLParagraphElement>(null);
  const removedRef = useRef<HTMLDivElement>(null);

  // Move focus onto the confirmation prompt so a screen-reader user hears the second,
  // destructive question rather than silently landing on a new button; and onto the
  // final status when it lands (WCAG 2.1 AA SC 4.1.3).
  useEffect(() => {
    if (phase === 'confirming') confirmHeadingRef.current?.focus();
    if (phase === 'removed') removedRef.current?.focus();
  }, [phase]);

  const memories = count === 1 ? 'memory' : 'memories';

  if (phase === 'removed') {
    return (
      <div
        ref={removedRef}
        role="status"
        tabIndex={-1}
        className="flex items-start gap-3 rounded-2xl border border-border-subtle bg-surface-raised p-5 outline-none"
      >
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sage-50 text-sage-600"
        >
          <Icon name="check" className="h-5 w-5" />
        </span>
        <p className="font-body text-base leading-relaxed text-text-secondary">
          Done — those memories were removed. {personName}&apos;s library is just as it was before.
        </p>
      </div>
    );
  }

  if (phase === 'confirming' || phase === 'removing') {
    const removing = phase === 'removing';
    return (
      <section
        aria-label="Undo this import"
        className="flex flex-col gap-4 rounded-2xl border border-border-subtle bg-surface-raised p-5"
      >
        <p
          ref={confirmHeadingRef}
          tabIndex={-1}
          className="font-body text-base leading-relaxed text-text-primary outline-none"
        >
          Remove the {count} {memories} this import just brought in? Everything that was already in{' '}
          {personName}&apos;s library stays exactly as it is, and you can always bring this import
          back later.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button
            variant="primary"
            disabled={removing}
            onClick={() => {
              setPhase('removing');
              void onUndo()
                .then(() => setPhase('removed'))
                .catch(() => setPhase('idle'));
            }}
          >
            {removing ? 'Removing…' : `Yes, remove ${count === 1 ? 'it' : 'them'}`}
          </Button>
          <Button variant="secondary" disabled={removing} onClick={() => setPhase('idle')}>
            Keep them
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Undo this import"
      className="flex flex-col gap-3 rounded-2xl border border-border-subtle bg-surface-raised p-5"
    >
      <p className="font-body text-base leading-relaxed text-text-secondary">
        Changed your mind? You can undo this import — it removes only what it just brought in, and
        leaves everything else in {personName}&apos;s library exactly as it is.
      </p>
      <div>
        <Button variant="secondary" onClick={() => setPhase('confirming')}>
          Undo this import
        </Button>
      </div>
    </section>
  );
}
