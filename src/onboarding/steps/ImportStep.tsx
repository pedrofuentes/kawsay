// Step 5 — Import. One component, four calm faces driven by the import state:
//   • progress    — a live percentage + running tally in a polite live region,
//                    with a reassuring "stop for now" that keeps what's found.
//   • complete     — a warm count and the single way forward into the app.
//   • cancelled    — what we kept before stopping, with the same way forward.
//   • error        — a gentle, code-free alert and a retry.
// Focus moves to the heading whenever the face changes, so the news is announced.
import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@renderer/components/Button';
import { ErrorBanner } from '@renderer/components/ErrorBanner';
import { Icon } from '@renderer/components/Icon';
import { ProgressBar } from '@renderer/components/ProgressBar';
import { ReassuranceNote } from '@renderer/components/ReassuranceNote';
import { SkippedItemsDisclosure } from '@renderer/components/SkippedItemsDisclosure';
import { UndoBanner } from '@renderer/components/UndoBanner';
import { pluralize } from '@renderer/lib/pluralize';
import type { ImportState } from '@renderer/lib/use-import';
import { StepContainer } from '../StepContainer';

export interface ImportStepProps {
  personName: string;
  state: ImportState;
  onCancel: () => void;
  onRetry: () => void;
  onSeeEverything: () => void;
  /**
   * Undo THIS import (#429, AC-14): called with the import's `sourceId` from the
   * post-import UndoBanner. Optional — a host that has no undo path (e.g. a preview)
   * simply omits it and the banner is not shown.
   */
  onUndo?: (sourceId: string) => Promise<void>;
}

type Face = 'progress' | 'complete' | 'cancelled' | 'error';

function faceOf(state: ImportState): Face {
  if (state.status === 'error') {
    return 'error';
  }
  if (state.status === 'complete') {
    return 'complete';
  }
  if (state.status === 'cancelled') {
    return 'cancelled';
  }
  return 'progress';
}

const HEADING_CLASS =
  'font-display text-3xl font-semibold leading-tight text-text-primary outline-none';

export function ImportStep({
  personName,
  state,
  onCancel,
  onRetry,
  onSeeEverything,
  onUndo,
}: ImportStepProps): ReactElement {
  const face = faceOf(state);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [face]);

  if (face === 'error') {
    return (
      <StepContainer>
        <h1 ref={headingRef} tabIndex={-1} className={HEADING_CLASS}>
          We hit a small snag
        </h1>
        <ErrorBanner
          message="Something interrupted bringing those in. Any memories already found are safe. Let's try that file again."
          onRetry={onRetry}
          retryLabel="Try again"
        />
      </StepContainer>
    );
  }

  if (face === 'complete' || face === 'cancelled') {
    const found = state.summary?.occurrencesAdded ?? 0;
    const skipped = state.summary?.skipped ?? [];
    const unreadable = skipped.filter((item) => item.code !== 'E_EXIF' && item.code !== 'E_PROBE');
    const partialMetadata = skipped.length - unreadable.length;
    return (
      <StepContainer>
        <span
          aria-hidden
          className="flex h-14 w-14 items-center justify-center rounded-full bg-sage-50 text-sage-600"
        >
          <Icon name="sparkle" className="h-7 w-7" />
        </span>
        <h1 ref={headingRef} tabIndex={-1} className={HEADING_CLASS}>
          {face === 'cancelled' ? 'Stopped — and kept' : "They're here"}
        </h1>
        <p className="font-body text-lg leading-relaxed text-text-secondary">
          {found} {pluralize(found, 'memory is', 'memories are')} now in {personName}&apos;s library.
        </p>
        {unreadable.length > 0 ? (
          <ReassuranceNote>
            We couldn&apos;t read {unreadable.length} {pluralize(unreadable.length, 'item', 'items')} — every
            other memory came through, and nothing was lost.
          </ReassuranceNote>
        ) : null}
        {partialMetadata > 0 ? (
          <ReassuranceNote>
            We couldn&apos;t read every detail for {partialMetadata}{' '}
            {pluralize(partialMetadata, 'memory', 'memories')}, but the{' '}
            {pluralize(partialMetadata, 'memory was', 'memories were')} still brought in.
          </ReassuranceNote>
        ) : null}
        <SkippedItemsDisclosure items={skipped} />
        {onUndo && state.sourceId !== null ? (
          <UndoBanner
            personName={personName}
            count={found}
            onUndo={() => onUndo(state.sourceId as string)}
          />
        ) : null}
        <div>
          <Button variant="primary" onClick={onSeeEverything}>
            See everything
          </Button>
        </div>
      </StepContainer>
    );
  }

  const hasTotal = state.total !== null && state.total > 0;
  const percent = hasTotal ? Math.round((state.processed / (state.total as number)) * 100) : 0;
  const activity = state.message ?? `Gently bringing ${personName}'s memories in…`;
  const cancelling = state.status === 'cancelling';

  return (
    <StepContainer>
      <h1 ref={headingRef} tabIndex={-1} className={HEADING_CLASS}>
        Bringing {personName}&apos;s memories in…
      </h1>
      <div aria-live="polite" aria-busy className="flex flex-col gap-4">
        <ProgressBar
          value={percent}
          max={100}
          label={`Bringing ${personName}'s memories in`}
          valueText={hasTotal ? `${percent} percent` : 'Getting ready'}
        />
        <p className="font-body text-base text-text-primary">{activity}</p>
        {hasTotal ? (
          <p className="font-body text-sm text-text-secondary">
            {state.processed} of {state.total} so far
          </p>
        ) : null}
      </div>
      <ReassuranceNote tone="pacing">
        This can take a little while for big exports. You can stop anytime — whatever has come in
        so far is kept.
      </ReassuranceNote>
      <div>
        <Button variant="secondary" onClick={onCancel} disabled={cancelling}>
          {cancelling ? 'Stopping…' : 'Stop for now'}
        </Button>
      </div>
    </StepContainer>
  );
}
