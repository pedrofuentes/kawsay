// Explicit-intent media playback inside a memory (Journey F / #428). A voice note
// or a home video is PLAYABLE here with native, keyboard-accessible controls; a
// photo opens full-size. Two things are sacred:
//
//   • Nothing EVER autoplays (P6 — "a loved one's voice never ambushes a grieving
//     user"). We render the native player with `controls` and NO `autoplay`, so the
//     visible play button waits for the user's explicit intent; `preload="metadata"`
//     fetches only enough to show duration/first-frame, never the whole recording.
//   • The bytes arrive over the hardened, LOCAL-ONLY `kawsay-media:` protocol. The
//     renderer names ONLY the opaque catalog id (`mediaUrl(item.id)`), never a path;
//     the main process resolves + confines the original and streams it. No filesystem
//     path or network origin is ever involved here (AC-4).
import type { ReactElement } from 'react';
import { mediaUrl } from '@shared/media';
import type { ItemCardDTO } from '@shared/kawsay-api';

/** The memory's own (untrusted) caption, or a calm fallback label — rendered by
 *  React as an escaped attribute value, never markup. */
function accessibleName(item: ItemCardDTO, fallback: string): string {
  const caption = (item.title ?? item.description ?? '').trim();
  return caption.length > 0 ? caption : fallback;
}

export function ItemMedia({ item }: { item: ItemCardDTO }): ReactElement | null {
  const src = mediaUrl(item.id);

  // media-has-caption is disabled deliberately: an audio/video memory's text
  // alternative is the read-only TRANSCRIPT panel shown alongside it in ItemView
  // ("What was said", #136 / AC-13), not a separate caption file (we have none to
  // point a <track> at). The transcript is the honest, screen-reader-readable
  // equivalent for these recordings.
  if (item.mediaType === 'audio') {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- transcript panel is the text alternative (#136)
      <audio
        controls
        preload="metadata"
        src={src}
        aria-label={`Voice note: ${accessibleName(item, 'this recording')}`}
        className="w-full"
      />
    );
  }

  if (item.mediaType === 'video') {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- transcript panel is the text alternative (#136)
      <video
        controls
        preload="metadata"
        playsInline
        src={src}
        aria-label={`Video: ${accessibleName(item, 'this recording')}`}
        className="max-h-[70vh] w-full rounded-2xl bg-black"
      />
    );
  }

  if (item.mediaType === 'photo') {
    return (
      <img
        src={src}
        alt={accessibleName(item, 'Photo')}
        className="max-h-[70vh] w-full rounded-2xl object-contain"
      />
    );
  }

  // Documents and messages have no inline media to play or open full-size.
  return null;
}
