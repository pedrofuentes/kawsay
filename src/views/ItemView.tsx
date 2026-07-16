// One memory opened on its own (#136). It reads the tile the user activated from
// the navigation state (no re-fetch needed for the card data), moves keyboard
// focus to its <h1> on mount like every primary view (WCAG 2.4.3 / AC-13), and —
// for an audio or video memory — shows its transcript read-only beneath. A calm
// "Back" returns to wherever the user came from (timeline or search). Everything
// shown is the renderer-safe DTO + the transcript view; no path or media byte is
// ever handled here (AC-4).
//
// ←/→ moves to the previous/next memory in timeline order (#434, the rest of
// #434 — see USER_FLOWS Journey F). The neighbours are derived entirely from
// `view.siblings` — the ordered page Timeline/Search already had loaded when the
// user opened this memory — so this needs no re-fetch and no new IPC channel.
import { useCallback, useEffect, useState } from 'react';
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

/** Title if present, else the calm type label ("Photo", "Voice note", …) —
 *  shared by the heading and the ←/→ live-region announcement so both agree. */
function headingOf(item: ItemCardDTO): string {
  const title = (item.title ?? '').trim();
  return title.length > 0 ? title : TYPE_LABEL[item.mediaType];
}

/** Interactive elements that already own Left/Right themselves (text cursor
 *  movement, native <select> option cycling, …) — the global arrow-nav listener
 *  defers to them rather than hijacking the keystroke. None exist on ItemView
 *  today, but the guard keeps the listener honest if one is ever added. */
function ownsArrowKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

export function ItemView(): ReactElement | null {
  const { view, navigate } = useNavigation();
  const headingRef = useAutoFocusHeading<HTMLHeadingElement>();

  const isItemView = view.name === 'item';
  const item = isItemView ? view.item : null;
  const from = isItemView ? view.from : undefined;
  // The ordered page this memory was opened FROM (Timeline's newest-first load,
  // or Search's current result set) — already in hand, so no re-fetch and no new
  // IPC channel are needed to find the previous/next memory (#434).
  const siblings = isItemView ? (view.siblings ?? []) : [];
  const via = isItemView ? view.via : undefined;

  const currentIndex = item !== null ? siblings.findIndex((sibling) => sibling.id === item.id) : -1;
  const prevItem = currentIndex > 0 ? siblings[currentIndex - 1] : null;
  const nextItem =
    currentIndex >= 0 && currentIndex < siblings.length - 1 ? siblings[currentIndex + 1] : null;

  const goTo = useCallback(
    (target: ItemCardDTO, direction: 'prev' | 'next'): void => {
      navigate({ name: 'item', item: target, from, siblings, via: direction });
    },
    [navigate, from, siblings],
  );

  // Global ←/→ handling — not scoped to a focused element, so it never traps
  // focus (Tab, Shift+Tab, and every other key keep working exactly as before;
  // nothing here calls preventDefault). Ignored with a modifier held (Alt/Ctrl/
  // Cmd+Arrow are OS/browser shortcuts, e.g. history back/forward) and deferred
  // to any element that owns arrow keys itself.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.altKey || event.ctrlKey || event.metaKey || ownsArrowKeys(event.target)) {
        return;
      }
      if (event.key === 'ArrowLeft' && prevItem !== null) {
        goTo(prevItem, 'prev');
      } else if (event.key === 'ArrowRight' && nextItem !== null) {
        goTo(nextItem, 'next');
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [prevItem, nextItem, goTo]);

  // A polite announcement for the memory ←/→ just landed on. `via` is a
  // transient hint set only by `goTo` above (never by a fresh open from
  // Timeline/Search), so opening a memory normally stays quiet here — its
  // focused <h1> already introduces it (WCAG 2.4.3), the same as every other
  // view transition in this app.
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (item === null || via === undefined) {
      setAnnouncement('');
      return;
    }
    const direction = via === 'prev' ? 'previous' : 'next';
    setAnnouncement(`Now showing the ${direction} memory: ${headingOf(item)}.`);
  }, [item, via]);

  // ItemView is only routed for the 'item' view; this narrows the type and keeps
  // the component safe if it is ever mounted without one.
  if (!isItemView || item === null) {
    return null;
  }

  const typeLabel = TYPE_LABEL[item.mediaType];
  const heading = headingOf(item);
  const dateText = formatDate(item.captureDate);
  const transcribable = item.mediaType === 'audio' || item.mediaType === 'video';

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => navigate(from ?? { name: 'timeline' })}>
          <Icon name="arrow-right" className="h-5 w-5 rotate-180" />
          Back
        </Button>
        {prevItem !== null || nextItem !== null ? (
          <div className="flex items-center gap-2">
            {prevItem !== null ? (
              <Button variant="ghost" onClick={() => goTo(prevItem, 'prev')}>
                <Icon name="arrow-right" className="h-5 w-5 rotate-180" />
                Previous
              </Button>
            ) : null}
            {nextItem !== null ? (
              <Button variant="ghost" onClick={() => goTo(nextItem, 'next')}>
                Next
                <Icon name="arrow-right" className="h-5 w-5" />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>

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
  const { isFavourite, isSaving, announcement, toggle } = useFavourite(item.id, item.isFavourite);
  return (
    <>
      <button
        type="button"
        aria-pressed={isFavourite}
        aria-busy={isSaving}
        aria-label={isFavourite ? 'Remove from favourites' : 'Mark as favourite'}
        onClick={toggle}
        disabled={isSaving}
        className={cx(
          'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-clay-500 transition-colors duration-150 hover:bg-surface-tinted disabled:cursor-not-allowed disabled:opacity-55',
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
