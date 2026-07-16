// The opt-in transcription consent card (AC-22 / ADR-0027 Decision 6c). It is the
// gentle screen that explains transcription and ASKS before Kawsay downloads the
// language model. Nothing here downloads or transcribes on its own: the model is
// fetched only when the user presses "Enable transcription", the feature stays
// gated until the model is present + verified (useModelDownload reads that gate),
// and the one global toggle reflects + controls the current state. Progress is
// announced politely and failures surface as calm, plain-language retries — never
// a raw code or stack trace. Per-item transcript display/search is issue #136.
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from './Button';
import { ConsentCardShell } from './ConsentCardShell';
import { ErrorBanner } from './ErrorBanner';
import { Icon } from './Icon';
import { ProgressBar } from './ProgressBar';
import { MODEL_SIZE_BYTES } from '@shared/transcription';
import { useModelDownload } from '@renderer/lib/use-model-download';
import type { ModelDownloadError } from '@renderer/lib/use-model-download';

const MIB = 1024 * 1024;

/** Whole megabytes, the unit the ~465 MB model size is quoted in (ADR-0027). */
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

  return (
    <ConsentCardShell
      headingId={headingId}
      icon="audio"
      title="Turn voice notes into words you can read"
      subtitle="On-device transcription — entirely optional, and off until you choose it."
      switchLabelId={switchLabelId}
      switchStatusId={switchStatusId}
      switchLabel="Transcribe audio & video"
      switchStatus={switchStatus()}
      on={on}
      switchDisabled={!model.ready}
      onToggle={() => setEnabled((value) => !value)}
    >
      {renderFace()}
    </ConsentCardShell>
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
              It all happens here, on this computer. A loved one&apos;s recordings and memories
              never leave this computer — there&apos;s no account, and nothing is ever uploaded.
            </p>
            <p className="font-body text-base leading-relaxed text-text-secondary">
              To set it up, Kawsay makes a one-time download of about {toMB(MODEL_SIZE_BYTES)} MB —
              the language model that does the listening. This is the only time the app uses the
              internet.
            </p>
            <p className="font-body text-base leading-relaxed text-text-secondary">
              Nothing is transcribed until you turn it on, and you can turn it off again whenever
              you like.
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
            title="Transcription can't be set up here"
            message="Kawsay can't set up transcription on this computer right now. You can keep using everything else, and a loved one's memories stay safe on this computer."
          />
        );
      }

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
