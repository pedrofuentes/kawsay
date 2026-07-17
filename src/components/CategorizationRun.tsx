// The categorization RUN controls — a calm card in Settings that lets a grieving,
// non-technical person gather related memories into suggested collections. It
// offers a single obvious action, then shows gentle live progress in a polite
// live region with a soft Stop. A gated refusal never errors: it guides the user
// in plain language. Nothing auto-starts.
import { useId } from 'react';
import type { ReactElement } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { useCategorizationStatus } from '@renderer/lib/use-categorization';
import { useCategorizationRun } from '@renderer/lib/use-categorization-run';

/** "<n> memory" / "<n> memories" — small, calm pluralisation. */
function memories(n: number): string {
  return `${n} ${n === 1 ? 'memory' : 'memories'}`;
}

export function CategorizationRun(): ReactElement {
  const run = useCategorizationRun();
  const { offered } = useCategorizationStatus();
  const headingId = useId();

  if (!offered) {
    return <></>;
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
          <Icon name="collection" className="h-6 w-6" />
        </span>
        <div className="flex flex-col gap-1">
          <h2
            id={headingId}
            className="font-display text-2xl font-semibold leading-tight text-text-primary"
          >
            Organize into collections
          </h2>
          <p className="font-body text-base text-text-secondary">
            Kawsay can look across your memories for the places and moments they share, and gently
            gather them into collections — all on this computer.
          </p>
        </div>
      </div>

      {renderFace()}
    </section>
  );

  function renderFace(): ReactElement {
    switch (run.face) {
      case 'running':
        return (
          <div className="flex flex-col gap-4">
            <p aria-live="polite" className="font-body text-base text-text-primary">
              Looking through your memories… {run.counts.categorized} gathered so far
            </p>
            <p className="font-body text-sm leading-relaxed text-text-secondary">
              You can keep using Kawsay while this finishes — there’s no rush.
            </p>
            <div>
              <Button variant="secondary" onClick={() => void run.cancel()}>
                Stop organizing
              </Button>
            </div>
          </div>
        );

      case 'complete':
        return (
          <div role="status" className="flex flex-col gap-3">
            <p className="font-body text-base leading-relaxed text-text-primary">
              {run.counts.categorized > 0
                ? `Done — Kawsay gathered ${memories(run.counts.categorized)} and suggested some collections below.`
                : 'All done — there was nothing new to gather just now.'}
            </p>
            {run.counts.failed > 0 ? (
              <p className="font-body text-base leading-relaxed text-text-secondary">
                A few memories couldn’t be sorted, and that’s okay — they’re safe and unchanged.
              </p>
            ) : null}
          </div>
        );

      case 'failed':
        return (
          <div role="status" className="flex flex-col gap-4">
            <p className="font-body text-base leading-relaxed text-text-primary">
              Something interrupted organizing, and nothing was changed — your memories are safe.
              You can try again whenever you’re ready.
            </p>
            <div>
              <Button variant="primary" onClick={() => void run.start()}>
                Try again
              </Button>
            </div>
          </div>
        );

      case 'refused':
        return (
          <div role="status" className="flex flex-col gap-3">
            <p className="font-body text-base leading-relaxed text-text-primary">
              {run.reason === 'not-opted-in'
                ? 'Before organizing, first turn on suggestions in the step above. Then come back here whenever you’re ready.'
                : 'There’s nothing to gather just yet. When you add memories with places or moments in common, you can organize them here.'}
            </p>
          </div>
        );

      case 'nothing':
        return (
          <p className="font-body text-base leading-relaxed text-text-secondary">
            Everything’s already organized. There’s nothing new to gather right now.
          </p>
        );

      case 'stopped':
        return (
          <div role="status">
            <p className="font-body text-base leading-relaxed text-text-primary">
              Organizing stopped. What was gathered so far is saved — you can pick up again whenever
              you like.
            </p>
          </div>
        );

      case 'intro':
      default:
        return (
          <div className="flex flex-col gap-4">
            <p className="font-body text-base leading-relaxed text-text-primary">
              Nothing starts until you choose it, and you can stop any time.
            </p>
            <div>
              <Button variant="primary" disabled={run.starting} onClick={() => void run.start()}>
                Organize now
              </Button>
            </div>
          </div>
        );
    }
  }
}
