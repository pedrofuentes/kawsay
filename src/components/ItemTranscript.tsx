// The per-item transcript panel (#136) — the spoken words of one audio/video
// memory, shown READ-ONLY (no player, nothing editable; AC-14 posture). When the
// words are ready they are tagged with the detected language so a screen reader
// pronounces Spanish/etc. correctly (the `lang` attribute, AC-13). Every other
// state — transcribing, not yet, couldn't, nothing-said — is told in calm, plain
// language, never a technical code. The text is UNTRUSTED and rendered as escaped
// React children, so smuggled markup can never become a live element (AC-4).
import { useId } from 'react';
import type { ReactElement } from 'react';
import type { ItemCardDTO } from '@shared/kawsay-api';
import { useTranscript } from '@renderer/lib/use-transcript';

export function ItemTranscript({ item }: { item: ItemCardDTO }): ReactElement {
  const transcript = useTranscript(item);
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-2xl border border-border-subtle bg-surface-raised p-6"
    >
      <h2 id={headingId} className="font-display text-xl font-semibold text-text-primary">
        What was said
      </h2>
      {renderBody()}
    </section>
  );

  function renderBody(): ReactElement {
    if (transcript.status === 'done') {
      // The detected language tags the words for assistive tech; a null language
      // must never become a bogus lang="" / lang="null" attribute, so we omit it.
      return (
        <div lang={transcript.language ?? undefined}>
          <p className="whitespace-pre-wrap font-body text-base leading-relaxed text-text-primary">
            {transcript.text}
          </p>
        </div>
      );
    }

    if (transcript.status === 'failed') {
      return (
        <p role="status" className="font-body text-base leading-relaxed text-text-secondary">
          {"This recording couldn't be transcribed — and that's okay. The recording itself is safe and unchanged."}
        </p>
      );
    }

    if (transcript.status === 'skipped') {
      return (
        <p role="status" className="font-body text-base leading-relaxed text-text-secondary">
          There were no spoken words to capture in this one.
        </p>
      );
    }

    // status === 'pending' (or still loading): a live run means it is being worked
    // on right now; otherwise it simply hasn't been transcribed yet.
    if (transcript.status === 'pending' && transcript.runActive) {
      return (
        <p aria-live="polite" className="font-body text-base leading-relaxed text-text-secondary">
          Transcribing this recording now… the words will appear here when they’re ready.
        </p>
      );
    }

    if (transcript.status === 'pending') {
      return (
        <p className="font-body text-base leading-relaxed text-text-secondary">
          This recording is not transcribed yet. You can turn its words into text from Settings.
        </p>
      );
    }

    // Still loading the first read.
    return (
      <p role="status" className="font-body text-base leading-relaxed text-text-secondary">
        Looking for the words…
      </p>
    );
  }
}
