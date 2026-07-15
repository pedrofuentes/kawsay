// One memory opened on its own (#136). It reads the tile the user activated from
// the navigation state (no re-fetch needed for the card data), moves keyboard
// focus to its <h1> on mount like every primary view (WCAG 2.4.3 / AC-13), and —
// for an audio or video memory — shows its transcript read-only beneath. A calm
// "Back" returns to wherever the user came from (timeline or search). Everything
// shown is the renderer-safe DTO + the transcript view; no path or media byte is
// ever handled here (AC-4).
import type { ReactElement } from 'react';
import { Button } from '@renderer/components/Button';
import { CategoryChips } from '@renderer/components/CategoryChips';
import { Icon } from '@renderer/components/Icon';
import type { IconName } from '@renderer/components/Icon';
import { ItemTranscript } from '@renderer/components/ItemTranscript';
import { MediaThumbnail } from '@renderer/components/MediaThumbnail';
import { cx } from '@renderer/lib/cx';
import { useAutoFocusHeading } from '@renderer/lib/use-auto-focus';
import { useFavourite } from '@renderer/lib/use-favourite';
import { useNavigation } from '@renderer/lib/navigation';
import type { ItemCardDTO, MediaType } from '@shared/kawsay-api';

const TYPE_LABEL: Record<MediaType, string> = {
  photo: 'Photo',
  video: 'Video',
  audio: 'Voice note',
  document: 'Document',
  message: 'Message',
};

const TYPE_ICON: Record<MediaType, IconName> = {
  photo: 'photos',
  video: 'video',
  audio: 'audio',
  document: 'document',
  message: 'messages',
};

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

function formatDate(iso: string | null): string | null {
  if (iso === null) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return DATE_FORMAT.format(new Date(time));
}

export function ItemView(): ReactElement | null {
  const { view, navigate } = useNavigation();
  const headingRef = useAutoFocusHeading<HTMLHeadingElement>();

  // ItemView is only routed for the 'item' view; this narrows the type and keeps
  // the component safe if it is ever mounted without one.
  if (view.name !== 'item') {
    return null;
  }

  const { item, from } = view;
  const typeLabel = TYPE_LABEL[item.mediaType];
  const title = (item.title ?? '').trim();
  const heading = title.length > 0 ? title : typeLabel;
  const dateText = formatDate(item.captureDate);
  const transcribable = item.mediaType === 'audio' || item.mediaType === 'video';

  return (
    <section className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" onClick={() => navigate(from ?? { name: 'timeline' })}>
          <Icon name="arrow-right" className="h-5 w-5 rotate-180" />
          Back
        </Button>
      </div>

      <header className="flex items-start gap-4">
        <MediaThumbnail
          item={item}
          icon={TYPE_ICON[item.mediaType]}
          className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-sunken text-sage-600"
          iconClassName="h-9 w-9"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-1">
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="font-display text-3xl font-semibold text-text-primary outline-none"
            >
              {heading}
            </h1>
            <FavouriteToggle item={item} />
          </div>
          <p className="flex flex-wrap items-center gap-x-2 font-body text-base text-text-secondary">
            <span>{typeLabel}</span>
            {dateText !== null ? (
              <>
                <span aria-hidden>·</span>
                <span>{dateText}</span>
              </>
            ) : null}
          </p>
        </div>
      </header>

      {transcribable ? <ItemTranscript item={item} /> : null}
      <CategoryChips item={item} />
    </section>
  );
}

/**
 * The favourite heart, made interactive (#434, part of #434 — arrow-nav and the
 * tour are separate later slices). A real toggle button (not a decorative icon):
 * `aria-pressed` carries the state, a generous ≥44px hit target (`h-11 w-11`)
 * meets the pointer-target rubric, and a polite live region announces the change
 * for a screen-reader user. Persists via the validated `catalog:setFavourite`
 * channel (backed by the `is_favourite` column that already exists on `items`,
 * ARCHITECTURE §4.2) — so a favourite marked here survives an app restart.
 */
function FavouriteToggle({ item }: { item: ItemCardDTO }): ReactElement {
  const { isFavourite, announcement, toggle } = useFavourite(item.id, item.isFavourite);
  return (
    <>
      <button
        type="button"
        aria-pressed={isFavourite}
        aria-label={isFavourite ? 'Remove from favourites' : 'Mark as favourite'}
        onClick={toggle}
        className={cx(
          'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-clay-500 transition-colors duration-150 hover:bg-surface-tinted',
        )}
      >
        <Icon name="heart" className={cx('h-6 w-6', isFavourite && 'fill-current')} />
      </button>
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
