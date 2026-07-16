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
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@renderer/components/Button';
import { CategoryChips } from '@renderer/components/CategoryChips';
import { Heading } from '@renderer/components/Heading';
import { Icon } from '@renderer/components/Icon';
import { ItemMedia } from '@renderer/components/ItemMedia';
import { ItemTranscript } from '@renderer/components/ItemTranscript';
import { MediaThumbnail } from '@renderer/components/MediaThumbnail';
import { cx } from '@renderer/lib/cx';
import { MEDIA_META } from '@renderer/lib/media-meta';
import { useAutoFocusHeading } from '@renderer/lib/use-auto-focus';
import { useFavourite } from '@renderer/lib/use-favourite';
import { useNavigation } from '@renderer/lib/navigation';
import type { ItemCardDTO } from '@shared/kawsay-api';

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
  return title.length > 0 ? title : MEDIA_META[item.mediaType].label;
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
  const { view, navigate, favouriteOverrides } = useNavigation();
  const headingRef = useAutoFocusHeading<HTMLHeadingElement>();

  const isItemView = view.name === 'item';
  const item = isItemView ? view.item : null;
  const from = isItemView ? view.from : undefined;
  const via = isItemView ? view.via : undefined;

  // The ordered page this memory was opened FROM (Timeline's newest-first load,
  // or Search's current result set) — already in hand, so no re-fetch and no new
  // IPC channel are needed to find the previous/next memory (#434). The raw
  // snapshot is frozen at open time; we overlay the navigation-owned favourite
  // OVERRIDES on top so any toggle that has SETTLED is reflected — including one
  // that resolved only after the user arrowed away (which unmounts this ItemView
  // via MainApp's id-keyed remount, so a local-state patch could not survive; the
  // override map lives ABOVE MainApp and does — #458 before-settle race). The map
  // carries settled values only, so a sibling card never flashes an optimistic
  // favourite that a still-pending save might revert (#488).
  const rawSiblings = isItemView ? view.siblings : undefined;
  const siblings = useMemo<ItemCardDTO[]>(() => {
    const base = rawSiblings ?? [];
    return base.map((sibling) => {
      const override = favouriteOverrides[sibling.id];
      return override !== undefined && override !== sibling.isFavourite
        ? { ...sibling, isFavourite: override }
        : sibling;
    });
  }, [rawSiblings, favouriteOverrides]);

  // The favourite flag to SEED the toggle with: the settled override if one
  // exists, else the value carried on the opened card. So arrowing back to a
  // memory whose favourite settled while away opens it already-correct.
  const seededFavourite =
    item !== null ? (favouriteOverrides[item.id] ?? item.isFavourite) : false;

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
  // nothing here calls preventDefault). It stands down whenever the arrow key
  // has a more local job to do: auto-repeat from a held key (avoid a burst of
  // remounts), a held modifier (Alt/Ctrl/Cmd+Arrow are OS/browser shortcuts like
  // history back/forward), a focused control that owns arrows itself, or — the
  // #458 review fix — a live text selection, so collapsing a selected transcript
  // sentence with ← never teleports the reader to another memory.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (ownsArrowKeys(event.target)) {
        return;
      }
      const selection = window.getSelection();
      if (selection !== null && !selection.isCollapsed) {
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

  const typeLabel = MEDIA_META[item.mediaType].label;
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
          icon={MEDIA_META[item.mediaType].icon}
          className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-sunken text-sage-600"
          iconClassName="h-9 w-9"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-1">
            <Heading headingRef={headingRef}>{heading}</Heading>
            <FavouriteToggle item={item} initialFavourite={seededFavourite} />
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

      <ItemMedia item={item} />
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
 *
 * `initialFavourite` is the flag to seed with when this memory has not been toggled
 * this session — the value on the opened card. Once toggled, the live value and busy
 * state come from the navigation-owned favourite state (keyed by id), so an arrow
 * away-and-back — even over a still in-flight save — reflects the SAME state instead
 * of the frozen open-time value (#458).
 */
function FavouriteToggle({
  item,
  initialFavourite,
}: {
  item: ItemCardDTO;
  initialFavourite: boolean;
}): ReactElement {
  const { isFavourite, isSaving, announcement, toggle } = useFavourite(item.id, initialFavourite);
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
