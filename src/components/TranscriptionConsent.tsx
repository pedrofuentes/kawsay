// The opt-in transcription consent card (AC-22 / ADR-0027 Decision 6c). It is the
// gentle screen that explains transcription and ASKS before Kawsay downloads the
// language model. Nothing here downloads or transcribes on its own: the model is
// fetched only when the user presses "Enable transcription", the feature stays
// gated until the model is present + verified (useModelDownload reads that gate),
// and the one global toggle reflects + controls the current state. Progress is
// announced politely and failures surface as calm, plain-language retries — never
// a raw code or stack trace. Per-item transcript display/search is issue #136.
import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from './Button';
import { ErrorBanner } from './ErrorBanner';
import { Icon } from './Icon';
import { ProgressBar } from './ProgressBar';
import { cx } from '@renderer/lib/cx';
import { useModelDownload } from '@renderer/lib/use-model-download';
import type { ModelDownloadError } from '@renderer/lib/use-model-download';

const MIB = 1024 * 1024;

/** Whole megabytes, the unit the ~466 MB model size is quoted in (ADR-0027). */
function toMB(bytes: number): number {
  return Math.round(bytes / MIB);
}

/** A calm, code-free sentence for each typed failure (raw messages are dropped). */
function errorMessage(error: ModelDownloadError | null): string {
  switch (error?.kind) {
    case 'network':
      return "Kawsay couldn't reach the internet to download the language model. Please check your connection, then try again.";
    case 'disk':
      return "There wasn't enough room on this computer to save the language model. Please free up some space, then try again.";
    case 'integrity':
      return "The download didn't arrive in one piece. Kawsay will fetch a fresh copy when you try again.";
    default:
      return "Something interrupted the download. Your memories are safe — let's try that again.";
  }
}

type Face = 'checking' | 'intro' | 'downloading' | 'error' | 'ready';

export function TranscriptionConsent(): ReactElement {
  const model = useModelDownload();
  // The global on/off preference once the model is ready. The durable "is it set
  // up" fact is the verified model on disk (model.ready); this is the finer control.
  const [enabled, setEnabled] = useState(true);

  const headingId = useId();
  const switchLabelId = useId();
  const switchStatusId = useId();

  const face = faceOf();
  const on = model.ready && enabled;

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
          <Icon name="audio" className="h-6 w-6" />
        </span>
        <div className="flex flex-col gap-1">
          <h2
            id={headingId}
            className="font-display text-2xl font-semibold leading-tight text-text-primary"
          >
            Turn voice notes into words you can read
          </h2>
          <p className="font-body text-base text-text-secondary">
            On-device transcription — entirely optional, and off until you choose it.
          </p>
        </div>
      </div>

      {/* The single global toggle: the state is always visible, and it stays
          disabled until the model is present + verified (the gate). */}
      <div className="flex items-center justify-between gap-4 rounded-xl bg-surface-sunken px-4 py-3">
        <div className="flex flex-col">
          <span id={switchLabelId} className="font-body text-base font-medium text-text-primary">
            Transcribe audio &amp; video
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
          disabled={!model.ready}
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
    if (model.status === 'error') return 'error';
    if (model.ready) return 'ready';
    if (model.status === 'checking') return 'checking';
    return 'intro';
  }

  function switchStatus(): string {
    if (model.ready) {
      return on
        ? 'On. Recordings can become text you can read and search — always on this computer.'
        : 'Off. You can turn this back on whenever you like.';
    }
    switch (face) {
      case 'downloading':
        return 'Setting it up now…';
      case 'error':
        return "Setup didn't finish.";
      case 'checking':
        return 'Checking your setup…';
      default:
        return "Transcription isn't set up yet.";
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
              Kawsay can gently turn recordings — audio, and the sound in videos — into text you can
              read and search, so you can find a moment again without listening through everything.
            </p>
            <p className="font-body text-base leading-relaxed text-text-secondary">
              It all happens here, on this computer. A loved one&apos;s recordings and memories never
              leave this computer — there&apos;s no account, and nothing is ever uploaded.
            </p>
            <p className="font-body text-base leading-relaxed text-text-secondary">
              To set it up, Kawsay makes a one-time download of about 466 MB — the language model
              that does the listening. This is the only time the app uses the internet.
            </p>
            <p className="font-body text-base leading-relaxed text-text-secondary">
              Nothing is transcribed until you turn it on, and you can turn it off again whenever you
              like.
            </p>
            <div>
              <Button variant="primary" onClick={() => void model.enable()}>
                Enable transcription
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
              label="Setting up transcription"
              valueText={verifying ? 'Checking the download' : `${percent} percent`}
            />
            <p className="font-body text-base text-text-primary">
              {verifying
                ? 'Almost there — checking the download…'
                : `${toMB(model.bytesDownloaded)} MB of ${toMB(total)} MB`}
            </p>
            <p className="font-body text-sm leading-relaxed text-text-secondary">
              Setting up transcription… this one-time download can take a few minutes. You can keep
              using Kawsay while it finishes.
            </p>
          </div>
        );
      }

      case 'error':
        return (
          <ErrorBanner
            title="We couldn't finish setting up"
            message={errorMessage(model.error)}
            onRetry={() => void model.retry()}
            retryLabel="Try again"
          />
        );

      case 'ready':
        return (
          <div className="flex flex-col gap-3">
            <p className="inline-flex items-center gap-2 font-body text-base font-medium text-text-primary">
              <span
                aria-hidden
                className="flex h-7 w-7 items-center justify-center rounded-full bg-sage-50 text-sage-600"
              >
                <Icon name="check" className="h-4 w-4" />
              </span>
              Transcription is ready
            </p>
            <p className="font-body text-base leading-relaxed text-text-secondary">
              Recordings can now be turned into text you can read and search. Everything stays on
              this computer.
            </p>
            <p className="font-body text-sm leading-relaxed text-text-secondary">
              Soon you&apos;ll be able to choose this for individual memories, too.
            </p>
          </div>
        );

      default:
        return null;
    }
  }
}
