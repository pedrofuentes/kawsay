// The transcription RUN controls (#136) — a calm card in Settings that lets a
// grieving, non-technical person turn their recordings into words they can read.
// It offers a single obvious action (Start), then shows gentle live progress in a
// polite live region with a soft Stop, and reflects a run already going or just
// finished when the window is reopened. A gated refusal never errors: it guides
// the user back to the setup step in plain language. Nothing auto-starts (AC-22).
import { useId } from 'react';
import type { ReactElement } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { useTranscriptionRun } from '@renderer/lib/use-transcription-run';

/** "<n> recording" / "<n> recordings" — small, calm pluralisation. */
function recordings(n: number): string {
  return `${n} ${n === 1 ? 'recording' : 'recordings'}`;
}

export function TranscriptionRun(): ReactElement {
  const run = useTranscriptionRun();
  const headingId = useId();

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
          <Icon name="document" className="h-6 w-6" />
        </span>
        <div className="flex flex-col gap-1">
          <h2
            id={headingId}
            className="font-display text-2xl font-semibold leading-tight text-text-primary"
          >
            Transcribe your recordings
          </h2>
          <p className="font-body text-base text-text-secondary">
            Go through your audio and videos and turn the talking into words you can read and search
            — all on this computer.
          </p>
        </div>
      </div>

      {renderFace()}
    </section>
  );

  function renderFace(): ReactElement {
    switch (run.face) {
      case 'running': {
        const settled = run.counts.transcribed + run.counts.failed + run.counts.skipped;
        return (
          <div className="flex flex-col gap-4">
            {/* Polite live region: the gentle count re-announces as it climbs,
                never a jarring alert. */}
            <p aria-live="polite" className="font-body text-base text-text-primary">
              Transcribing your recordings… {settled} of {run.counts.total}
            </p>
            <p className="font-body text-sm leading-relaxed text-text-secondary">
              You can keep using Kawsay while this finishes — it can take a little while, and there’s
              no rush.
            </p>
            <div>
              <Button variant="secondary" onClick={() => void run.cancel()}>
                Stop transcribing
              </Button>
            </div>
          </div>
        );
      }

      case 'complete':
        return (
          <div role="status" className="flex flex-col gap-3">
            <p className="font-body text-base leading-relaxed text-text-primary">
              {run.counts.transcribed > 0
                ? `Transcribing is finished — ${recordings(run.counts.transcribed)} now ${
                    run.counts.transcribed === 1 ? 'has' : 'have'
                  } words you can read.`
                : 'Transcribing is finished.'}
            </p>
            {run.counts.failed > 0 ? (
              <p className="font-body text-base leading-relaxed text-text-secondary">
                {`${recordings(run.counts.failed)} couldn't be transcribed, and that's okay — the recordings themselves are safe and unchanged.`}
              </p>
            ) : null}
            {run.counts.skipped > 0 ? (
              <p className="font-body text-base leading-relaxed text-text-secondary">
                {recordings(run.counts.skipped)} had no spoken words to capture.
              </p>
            ) : null}
          </div>
        );

      case 'refused':
        // Calm, code-free guidance — a polite status region, never an alert.
        return (
          <div role="status" className="flex flex-col gap-3">
            {run.reason === 'model-not-ready' ? (
              <p className="font-body text-base leading-relaxed text-text-primary">
                Transcription is still setting up. Once it’s ready, you can start transcribing
                whenever you like.
              </p>
            ) : (
              <p className="font-body text-base leading-relaxed text-text-primary">
                Before transcribing, first turn on transcription in the step above. Then come back
                here whenever you’re ready.
              </p>
            )}
          </div>
        );

      case 'empty':
        return (
          <p className="font-body text-base leading-relaxed text-text-secondary">
            There are no recordings to transcribe just yet. When you add audio or video, you can turn
            them into words right here.
          </p>
        );

      case 'all-done':
        return (
          <p className="font-body text-base leading-relaxed text-text-secondary">
            Every recording already has words you can read. There’s nothing left to transcribe.
          </p>
        );

      case 'intro':
      default:
        return (
          <div className="flex flex-col gap-4">
            <p className="font-body text-base leading-relaxed text-text-primary">
              When you’re ready, Kawsay will quietly work through your recordings. Nothing starts
              until you choose it, and you can stop any time.
            </p>
            <div>
              <Button variant="primary" disabled={run.starting} onClick={() => void run.start()}>
                Start transcribing
              </Button>
            </div>
          </div>
        );
    }
  }
}
