// The shared media tile used by the Timeline and Search cards (U4). It shows a
// real thumbnail for a renderable memory and the media-type ICON as the fallback
// for everything else — non-visual items, while the bytes are loading, or if the
// render failed. The security posture is the whole point:
//
//   • the renderer passes ONLY the opaque catalog id to `getThumbnail` — never a
//     path; the main process resolves + confines the original and returns a
//     bounded image `data:` URL (or null), so no filesystem path or network
//     origin is ever involved here (AC-4);
//   • the alt text is the memory's own (UNTRUSTED) caption, rendered by React as
//     an attribute value — escaped data, never markup;
//   • fetching is lazy: only items the virtualized window actually mounts ask for
//     a thumbnail, and a module-level memo means a scrolled-back tile never re-asks.
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Icon } from '@renderer/components/Icon';
import type { IconName } from '@renderer/components/Icon';
import { cx } from '@renderer/lib/cx';
import { useKawsayApi } from '@renderer/lib/kawsay-api';
import { usePrefersReducedMotion } from '@renderer/lib/use-reduced-motion';
import type { ItemCardDTO } from '@shared/kawsay-api';

// Resolved data: URLs (or null for "no thumbnail"), keyed by item id, kept across
// virtualized remounts so re-scrolling a card never reloads or flickers.
const THUMBNAIL_MEMO_LIMIT = 256;
const thumbnailMemo = new Map<string, string | null>();

function readThumbnailMemo(id: string): string | null | undefined {
  const value = thumbnailMemo.get(id);
  if (value === undefined) return undefined;
  thumbnailMemo.delete(id);
  thumbnailMemo.set(id, value);
  return value;
}

function writeThumbnailMemo(id: string, value: string | null): void {
  if (thumbnailMemo.has(id)) thumbnailMemo.delete(id);
  thumbnailMemo.set(id, value);
  while (thumbnailMemo.size > THUMBNAIL_MEMO_LIMIT) {
    const oldest = thumbnailMemo.keys().next().value;
    if (oldest === undefined) break;
    thumbnailMemo.delete(oldest);
  }
}

interface MediaThumbnailProps {
  item: ItemCardDTO;
  /** The media-type icon shown whenever no thumbnail is displayed. */
  icon: IconName;
  /** Classes for the framing box (sizing/shape differ between the two views). */
  className?: string;
  /** Classes for the fallback icon glyph. */
  iconClassName?: string;
}

export function MediaThumbnail({
  item,
  icon,
  className,
  iconClassName,
}: MediaThumbnailProps): ReactElement {
  const api = useKawsayApi();
  const reducedMotion = usePrefersReducedMotion();
  const caption = (item.title ?? item.description ?? '').trim();
  const [dataUrl, setDataUrl] = useState<string | null>(() => readThumbnailMemo(item.id) ?? null);

  useEffect(() => {
    // Only renderable memories ask for bytes; a browser preview (no bridge) and
    // non-visual items simply keep the icon.
    if (!item.hasThumbnail || api === undefined) return;

    const cached = readThumbnailMemo(item.id);
    if (cached !== undefined) {
      setDataUrl(cached);
      return;
    }

    let active = true;
    void api
      .getThumbnail({ id: item.id })
      .then((url) => {
        writeThumbnailMemo(item.id, url);
        if (active) setDataUrl(url);
      })
      .catch(() => {
        // One unreadable original must never break the view — fall back to the icon.
        writeThumbnailMemo(item.id, null);
        if (active) setDataUrl(null);
      });
    return () => {
      active = false;
    };
  }, [api, item.id, item.hasThumbnail]);

  const showImage = item.hasThumbnail && dataUrl !== null;

  return (
    <span className={className}>
      {showImage ? (
        <img
          src={dataUrl}
          alt={caption}
          loading="lazy"
          decoding="async"
          className={cx('h-full w-full object-cover', !reducedMotion && 'thumb-fade-in')}
        />
      ) : (
        <Icon name={icon} className={iconClassName} />
      )}
    </span>
  );
}
