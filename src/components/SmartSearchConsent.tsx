// The opt-in SMART-SEARCH consent card (M4-1b / ADR-0029). It mirrors the
// transcription consent card: a gentle screen that explains searching by MEANING
// and ASKS before Kawsay downloads the embedder model. Nothing here downloads or
// searches on its own — the model is fetched only when the user presses "Enable
// smart search", the feature stays gated until the model is present + verified
// (useSmartSearchModel reads that gate), and the one global toggle reflects +
// controls the current state. Progress is announced politely and failures surface
// as calm, plain-language retries — never a raw code or stack trace.
//
// Visibility gate: the whole card stays HIDDEN until smart search is `offered`
// (a real embedder model published AND installable on this platform). `offered`
// flips true via the maintainer's go-live finalize PR — auto-revealing this card
// with NO code change here — so pre-publish the user never sees an unusable
// surface and search remains exact FTS.
//
// Kept deliberately independent of the transcription card (its own hook, copy, and
// voice): this is about finding memories by what they mean, not about audio.
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from './Button';
import { ErrorBanner } from './ErrorBanner';
import { Icon } from './Icon';
import { ProgressBar } from './ProgressBar';
import { cx } from '@renderer/lib/cx';
import { SMART_SEARCH_MODEL_SIZE_BYTES } from '@shared/smart-search';
import { useSmartSearchModel } from '@renderer/lib/use-smart-search-model';
import type { SmartSearchModelError } from '@renderer/lib/use-smart-search-model';

const MIB = 1024 * 1024;

/** Whole megabytes, the unit the ~119 MB model size is quoted in. */
function toMB(bytes: number): number {
  return Math.round(bytes / MIB);
}

/** A calm, code-free sentence for each typed failure (raw messages are dropped). */
function errorMessage(error: SmartSearchModelError | null): string {
  switch (error?.kind) {
    case 'network':
      return "Kawsay couldn't reach the internet to download the smart-search model. Please check your connection, then try again.";
    case 'disk':
      return "There wasn't enough room on this computer to save the smart-search model. Please free up some space, then try again.";
    case 'integrity':
      return "The download didn't arrive in one piece. Kawsay will fetch a fresh copy when you try again.";
    default:
      return "Something interrupted the download. Your memories are safe — let's try that again.";
  }
}

type Face = 'checking' | 'intro' | 'downloading' | 'error' | 'ready' | 'unsupported';

export function SmartSearchConsent(): ReactElement | null {
  const model = useSmartSearchModel();
  // The global on/off preference once the model is ready. The durable "is it set
  // up" fact is the verified model on disk (model.modelReady); this is the finer
  // control.
  const [enabled, setEnabled] = useState(true);

  const headingId = useId();
  const switchLabelId = useId();
  const switchStatusId = useId();

  const face = faceOf();
  const on = model.modelReady && enabled;

  const readyRef = useRef<HTMLDivElement>(null);
  const prevFaceRef = useRef<Face | null>(null);

  // Announce + re-orient on success: when the download finishes and the "Enable"
  // button unmounts, move focus to the ready confirmation (a polite status region)
  // so a screen-reader user actually hears it (WCAG 2.1 AA SC 4.1.3). Arriving
  // already-ready on mount (previous face was not 'downloading') must NOT steal focus.
  useEffect(() => {
    if (face === 'ready' && prevFaceRef.current === 'downloading') {
      readyRef.current?.focus();
    }
    prevFaceRef.current = face;
  }, [face]);

  // While the one-time capability check resolves, stay quiet — render nothing.
  if (model.status === 'checking') {
    return null;
  }
  // The card is hidden entirely until smart search is offered (published +
  // installable). This flips on with no code change once the maintainer's finalize
  // PR ships the real model and `offered` becomes true.
  if (!model.offered) {
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
          <Icon name="search" className="h-6 w-6" />
        </span>
        <div className="flex flex-col gap-1">
          <h2
            id={headingId}
            className="font-display text-2xl font-semibold leading-tight text-text-primary"
          >
            Find memories by what they&apos;re about
          </h2>
          <p className="font-body text-base text-text-secondary">
            On-device smart search — entirely optional, and off until you choose it.
          </p>
        </div>
      </div>

      {/* The single global toggle: the state is always visible, and it stays
          disabled until the model is present + verified (the gate). */}
      <div className="flex items-center justify-between gap-4 rounded-xl bg-surface-sunken px-4 py-3">
        <div className="flex flex-col">
          <span id={switchLabelId} className="font-body text-base font-medium text-text-primary">
            Search by meaning
          </span>
          <span id={switchStatusId} className="font-body text-sm text-text-secondary">
            {switchStatus()}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={switchLabelId}
          aria-describedby={switchStatusId}
          disabled={!model.modelReady}
          onClick={() => setEnabled((value) => !value)}
          className={cx(
            'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-55',
            on ? 'bg-sage-600' : 'bg-border-interactive',
          )}
        >
          <span
            aria-hidden
            className={cx(
              'inline-block h-5 w-5 rounded-full bg-surface-raised transition-transform duration-150',
              on ? 'translate-x-6' : 'translate-x-1',
            )}
          />
        </button>
      </div>

      {renderFace()}
    </section>
  );

  function faceOf(): Face {
    if (model.status === 'downloading') return 'downloading';
    if (model.status === 'unsupported') return 'unsupported';
    if (model.status === 'error') return 'error';
    if (model.modelReady) return 'ready';
    if (model.status === 'checking') return 'checking';
    return 'intro';
  }

  function switchStatus(): string {
    if (model.modelReady) {
      return on
        ? 'On. You can find memories by what they mean — always on this computer.'
        : 'Off. You can turn this back on whenever you like.';
    }
    switch (face) {
      case 'downloading':
        return 'Setting it up now…';
      case 'error':
        return "Setup didn't finish.";
      case 'unsupported':
        return "Smart search isn't available here.";
      case 'checking':
        return 'Checking your setup…';
      default:
        return "Smart search isn't set up yet.";
    }
  }

  function renderFace(): ReactElement | null {
    switch (face) {
      case 'checking':
        return (
          <p className="font-body text-base text-text-secondary" aria-live="polite">
            Checking your setup…
          </p>
        );

      case 'intro':
        return (
          <div className="flex flex-col gap-4">
            <p className="font-body text-base leading-relaxed text-text-primary">
              Kawsay can help you find memories by what they&apos;re about — not just the exact
              words in them. Search for a feeling or a place, and it can gently surface the right
              moments, even ones that never say those words.
            </p>
            <p className="font-body text-base leading-relaxed text-text-secondary">
              It all happens here, on this computer. A loved one&apos;s memories never leave this
              computer — there&apos;s no account, and nothing is ever uploaded.
            </p>
            <p className="font-body text-base leading-relaxed text-text-secondary">
              To set it up, Kawsay makes a one-time download of about{' '}
              {toMB(SMART_SEARCH_MODEL_SIZE_BYTES)} MB — the model that understands meaning. This is
              the only time the app uses the internet.
            </p>
            <p className="font-body text-base leading-relaxed text-text-secondary">
              Nothing is searched by meaning until you turn it on, and you can turn it off again
              whenever you like.
            </p>
            <div>
              <Button variant="primary" onClick={() => void model.enable()}>
                Enable smart search
              </Button>
            </div>
          </div>
        );

      case 'downloading': {
        const total = model.totalBytes;
        const percent = total > 0 ? Math.round((model.bytesDownloaded / total) * 100) : 0;
        const verifying = model.phase === 'verifying';
        return (
          <div aria-live="polite" aria-busy className="flex flex-col gap-4">
            <ProgressBar
              value={percent}
              max={100}
              label="Setting up smart search"
              valueText={verifying ? 'Checking the download' : `${percent} percent`}
            />
            <p className="font-body text-base text-text-primary">
              {verifying
                ? 'Almost there — checking the download…'
                : `${toMB(model.bytesDownloaded)} MB of ${toMB(total)} MB`}
            </p>
            <p className="font-body text-sm leading-relaxed text-text-secondary">
              Setting up smart search… this one-time download can take a few minutes. You can keep
              using Kawsay while it finishes.
            </p>
          </div>
        );
      }

      case 'error': {
        // Honour the typed `retryable` flag: a permanent failure (e.g. 403/404, or a
        // permission / cross-device / read-only install) would deterministically fail
        // every retry, so we drop "Try again" and offer calm alternate guidance rather
        // than trapping a grieving user in an endless, hopeless loop. Unknown failures
        // default to retryable — better to let them try than to dead-end them.
        const retryable = model.error?.retryable ?? true;
        return retryable ? (
          <ErrorBanner
            title="We couldn't finish setting up"
            message={errorMessage(model.error)}
            onRetry={() => void model.retry()}
            retryLabel="Try again"
          />
        ) : (
          <ErrorBanner
            title="Smart search can't be set up here"
            message="Kawsay can't set up smart search on this computer right now. You can keep searching by the exact words in your memories, and a loved one's memories stay safe on this computer."
          />
        );
      }

      case 'unsupported':
        // The platform has nowhere to install the model, so this is terminal and
        // NON-retryable (mirrors the non-retryable error face). Reassure: exact
        // search still works, and everything stays on this computer.
        return (
          <ErrorBanner
            title="Smart search isn't available on this computer"
            message="This computer can't set up smart search right now. You can still search by the exact words in your memories, and everything stays on this computer."
          />
        );

      case 'ready':
        return (
          <div
            ref={readyRef}
            role="status"
            tabIndex={-1}
            className="flex flex-col gap-3 outline-none"
          >
            <p className="inline-flex items-center gap-2 font-body text-base font-medium text-text-primary">
              <span
                aria-hidden
                className="flex h-7 w-7 items-center justify-center rounded-full bg-sage-50 text-sage-600"
              >
                <Icon name="check" className="h-4 w-4" />
              </span>
              Smart search is ready
            </p>
            <p className="font-body text-base leading-relaxed text-text-secondary">
              You can now find memories by what they mean, not just the exact words. Everything
              stays on this computer.
            </p>
            <p className="font-body text-sm leading-relaxed text-text-secondary">
              Turn it off again any time — a loved one&apos;s memories stay right here.
            </p>
          </div>
        );

      default:
        return null;
    }
  }
}
