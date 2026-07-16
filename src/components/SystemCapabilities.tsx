// A calm, reverent notice for a DEGRADED bundled capability (#441). Most of the app's
// optional features already show their own state (the transcription / smart-search /
// categorization consent cards). This card covers the one packaging-level degrade with
// a clear user-facing effect: when the media component behind video / voice-note
// previews couldn't be found on this computer, previews quietly fall back to an icon —
// so we say so, gently, rather than leaving the user wondering why previews never play.
//
// It stays HIDDEN while the capability probe is resolving and whenever media previews
// are available (the healthy build) or the probe couldn't be read — so a normal,
// fully-staged install shows nothing here. The technical cause (a missing bundled
// binary, a possible packaging regression) is logged loudly MAIN-SIDE; the renderer
// copy is plain-language and non-alarming, and reassures that everything stays local.
import { useId } from 'react';
import type { ReactElement } from 'react';
import { Icon } from './Icon';
import { useCapabilities } from '@renderer/lib/use-capabilities';

export function SystemCapabilities(): ReactElement | null {
  const { status, capabilities } = useCapabilities();
  const headingId = useId();

  // Stay quiet while probing, when the report is unknown, or when the build is healthy.
  if (status !== 'ready' || capabilities === null) {
    return null;
  }
  // The one user-facing packaging degrade we surface: the media tools behind video +
  // voice-note previews (ffmpeg/ffprobe). Every other seam either has its own card or
  // has no visible effect for the user.
  const mediaAvailable = capabilities.ffmpeg && capabilities.ffprobe;
  if (mediaAvailable) {
    return null;
  }

  return (
    <section
      role="status"
      aria-labelledby={headingId}
      className="flex items-start gap-4 rounded-2xl border border-border-subtle bg-surface-raised p-6"
    >
      <span
        aria-hidden
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-sage-50 text-sage-600"
      >
        <Icon name="video" className="h-6 w-6" />
      </span>
      <div className="flex flex-col gap-2">
        <h2
          id={headingId}
          className="font-display text-2xl font-semibold leading-tight text-text-primary"
        >
          Video and voice-note previews aren&apos;t available
        </h2>
        <p className="font-body text-base leading-relaxed text-text-secondary">
          This computer is missing something Kawsay needs to make and play previews of videos and
          voice notes. You can still see and open every memory — only the moving previews are
          affected.
        </p>
        <p className="font-body text-base leading-relaxed text-text-secondary">
          Everything you&apos;ve gathered stays safe, right here on this computer.
        </p>
      </div>
    </section>
  );
}
