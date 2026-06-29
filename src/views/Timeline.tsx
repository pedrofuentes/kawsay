// Journey D — the app's true home: a calm, reverse-chronological timeline of
// every gathered memory, grouped by month and virtualized so it stays fast at
// tens of thousands of items (AC-6, AC-8). It reads pages through the typed
// `window.kawsayAPI` bridge only (no network — AC-4) and renders untrusted
// catalog text (a loved one's captions, filenames) as escaped data, never markup.
//
// Thumbnails: the renderer-facing `ItemCardDTO` still exposes no filesystem path
// or asset URL. Instead, a renderable memory (photo/video) carries a `hasThumbnail`
// hint, and the card asks the main process for the bytes by OPAQUE id through the
// zero-egress `catalog:thumbnail` channel (which returns a bounded image data: URL
// or null). The shared <MediaThumbnail> renders that <img> lazily and falls back
// to the gentle per-type icon while loading, on error, or for non-visual items —
// which is also the documented thumb-error state (USER_FLOWS Journey D).
// Virtualization provides the "lazy, bounded" mounting AC-8 requires: only the
// on-screen window is ever in the DOM (so only it ever requests a thumbnail).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@renderer/components/Button';
import { EmptyState } from '@renderer/components/EmptyState';
import { ErrorBanner } from '@renderer/components/ErrorBanner';
import { Icon } from '@renderer/components/Icon';
import type { IconName } from '@renderer/components/Icon';
import { MediaThumbnail } from '@renderer/components/MediaThumbnail';
import { cx } from '@renderer/lib/cx';
import { useLibrary } from '@renderer/lib/library';
import { useNavigation } from '@renderer/lib/navigation';
import { useTimeline } from '@renderer/lib/use-timeline';
import { useAutoFocusHeading } from '@renderer/lib/use-auto-focus';
import { computeVirtualWindow } from '@renderer/lib/virtual-window';
import type { ItemCardDTO, MediaType } from '@shared/kawsay-api';

/** Every virtualized row shares one fixed height so the windowing maths stay
 *  layout-free (no per-row measurement). */
const ROW_HEIGHT = 116;
const OVERSCAN = 4;
/** Used before the scroll container has been measured (first paint, jsdom). */
const DEFAULT_VIEWPORT = 720;
/** Begin streaming the next page this many rows before the loaded list ends. */
const LOAD_MORE_AHEAD = OVERSCAN + 2;

const MEDIA_LABEL: Record<MediaType, string> = {
  photo: 'Photo',
  video: 'Video',
  audio: 'Voice note',
  document: 'Document',
  message: 'Message',
};

const MEDIA_ICON: Record<MediaType, IconName> = {
  photo: 'photos',
  video: 'video',
  audio: 'audio',
  document: 'document',
  message: 'messages',
};

const UNDATED_LABEL = 'Date unknown';
// Format in UTC so month grouping is deterministic regardless of the machine's
// timezone (capture timestamps are stored as UTC ISO strings).
const MONTH_FMT = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const DAY_FMT = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function parseDate(raw: string | null): Date | null {
  if (raw === null) {
    return null;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthKey(date: Date | null): string {
  return date === null ? 'undated' : `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
}

function monthLabel(date: Date | null): string {
  return date === null ? UNDATED_LABEL : MONTH_FMT.format(date);
}

function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

type Row =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'item'; key: string; item: ItemCardDTO };

/** Flatten the (already newest-first) items into a header + item row sequence,
 *  starting a new month header whenever the month changes. */
function buildRows(items: ItemCardDTO[]): Row[] {
  const rows: Row[] = [];
  let activeKey: string | null = null;
  for (const item of items) {
    const date = parseDate(item.captureDate);
    const key = monthKey(date);
    if (key !== activeKey) {
      activeKey = key;
      rows.push({ kind: 'header', key: `h:${key}:${rows.length}`, label: monthLabel(date) });
    }
    rows.push({ kind: 'item', key: `i:${item.id}:${rows.length}`, item });
  }
  return rows;
}

export function Timeline(): ReactElement {
  const { navigate } = useNavigation();
  const { library } = useLibrary();
  const { items, status, hasMore, loadMore, reload } = useTimeline();

  const who = library?.name?.trim() ?? '';
  const headingTitle = who.length > 0 ? `${who}'s timeline` : 'Timeline';
  const memoriesLabel = `${who.length > 0 ? `${who}'s` : 'Your'} memories`;

  const headingRef = useAutoFocusHeading<HTMLHeadingElement>();
  const scrollRef = useRef<HTMLElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT);

  const rows = useMemo(() => buildRows(items), [items]);
  const windowed = computeVirtualWindow({
    scrollTop,
    viewportHeight: viewportHeight > 0 ? viewportHeight : DEFAULT_VIEWPORT,
    rowHeight: ROW_HEIGHT,
    rowCount: rows.length,
    overscan: OVERSCAN,
  });

  // Keep the viewport height in sync with the real scroll container once it is
  // mounted; fall back to a sensible default when layout is unmeasured.
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) {
      return undefined;
    }
    const measure = (): void => {
      setViewportHeight(element.clientHeight > 0 ? element.clientHeight : DEFAULT_VIEWPORT);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [status]);

  // Stream the next page as the window approaches the end of what's loaded.
  useEffect(() => {
    if (status === 'ready' && hasMore && windowed.endIndex >= rows.length - LOAD_MORE_AHEAD) {
      loadMore();
    }
  }, [status, hasMore, windowed.endIndex, rows.length, loadMore]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLElement>): void => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const retryWithStableFocus = useCallback(
    (retry: () => void): void => {
      retry();
      headingRef.current?.focus();
    },
    [headingRef],
  );

  return (
    <div className="flex h-full flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-3xl font-semibold text-text-primary outline-none"
        >
          {headingTitle}
        </h1>
        {status === 'ready' && items.length > 0 ? (
          <p className="font-body text-base text-text-secondary">Everything, newest first.</p>
        ) : null}
      </header>
      {renderBody()}
    </div>
  );

  function renderBody(): ReactElement {
    if (status === 'unavailable') {
      return (
        <EmptyState
          icon={<Icon name="lock" className="h-8 w-8" />}
          title="We can't reach the library right now"
          description="Kawsay is not connected on this device, so there's nothing to show here yet."
        />
      );
    }

    if (status === 'loading') {
      return <TimelineLoading who={who} />;
    }

    if (status === 'error' && items.length === 0) {
      return (
        <ErrorBanner
          title="We couldn't open the timeline just now"
          message="Nothing is lost — your memories are safe on this computer. Let's try once more."
          onRetry={() => retryWithStableFocus(reload)}
        />
      );
    }

    if (items.length === 0) {
      return (
        <EmptyState
          icon={<Icon name="heart" className="h-8 w-8" />}
          title={who.length > 0 ? `${who}'s memories will gather here` : 'Their memories will gather here'}
          description="As you bring in chats, photos, and messages, they'll appear here in a gentle timeline."
          action={
            <Button variant="primary" onClick={() => navigate({ name: 'add-memories' })}>
              Add memories
            </Button>
          }
        />
      );
    }

    return (
      <>
        <section
          ref={scrollRef}
          aria-label={memoriesLabel}
          aria-busy={status === 'loadingMore'}
          onScroll={handleScroll}
          className="min-h-0 flex-1 overflow-y-auto pr-1"
        >
          <div style={{ height: windowed.totalHeight }} className="relative w-full">
            <ol
              style={{ transform: `translateY(${windowed.topPad}px)` }}
              className="absolute inset-x-0 top-0 m-0 list-none p-0"
            >
              {rows.slice(windowed.startIndex, windowed.endIndex).map(renderRow)}
            </ol>
          </div>
        </section>
        {status === 'error' ? (
          // A later page failed to load. Keep every memory already gathered on
          // screen and offer a calm, non-blocking way to try for more again —
          // never a silent dead-stop (the first page's error path is separate).
          <ErrorBanner
            title="We couldn't load more memories just now"
            message="Nothing is lost — everything already here is safe on this computer. Let's try for more again."
            onRetry={() => retryWithStableFocus(loadMore)}
          />
        ) : null}
      </>
    );
  }
}

function renderRow(row: Row): ReactElement {
  if (row.kind === 'header') {
    return (
      <li key={row.key} style={{ height: ROW_HEIGHT }} className="flex items-end pb-2">
        <h2 className="font-display text-xl font-semibold text-text-primary">{row.label}</h2>
      </li>
    );
  }
  return (
    <li key={row.key} style={{ height: ROW_HEIGHT }} className="pb-3">
      <MemoryCard item={row.item} />
    </li>
  );
}

function MemoryCard({ item }: { item: ItemCardDTO }): ReactElement {
  const { navigate, view } = useNavigation();
  const date = parseDate(item.captureDate);
  const dateText = date === null ? UNDATED_LABEL : DAY_FMT.format(date);
  const typeLabel = MEDIA_LABEL[item.mediaType];
  const caption = (item.title ?? item.description ?? '').trim();
  const durationText =
    item.durationSec !== null && item.durationSec > 0 ? formatDuration(item.durationSec) : null;
  const accessibleName = [typeLabel, caption, dateText].filter((part) => part.length > 0).join(', ');

  return (
    <article
      aria-label={accessibleName}
      className="flex h-full items-center gap-4 rounded-lg border border-border-subtle bg-surface-raised p-4 shadow-sm"
    >
      {/* The whole tile is one button that opens the memory on its own view. The
          favourite heart stays OUTSIDE it so we never nest an interactive control
          (axe nested-interactive); the global :focus-visible ring covers focus. */}
      <button
        type="button"
        onClick={() => navigate({ name: 'item', item, from: view })}
        aria-label={`Open ${caption.length > 0 ? caption : typeLabel}`}
        className="flex min-w-0 flex-1 items-center gap-4 rounded-md text-left"
      >
        <MediaThumbnail
          item={item}
          icon={MEDIA_ICON[item.mediaType]}
          className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-sunken text-sage-600"
          iconClassName="h-7 w-7"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate font-body text-md text-text-primary">{caption.length > 0 ? caption : typeLabel}</p>
          <p className="flex items-center gap-2 font-body text-sm text-text-secondary">
            <span>{typeLabel}</span>
            <span aria-hidden>·</span>
            <span>{dateText}</span>
            {durationText !== null ? (
              <>
                <span aria-hidden>·</span>
                <span>{durationText}</span>
              </>
            ) : null}
          </p>
        </div>
      </button>
      {item.isFavourite ? (
        <Icon name="heart" label="Favourite" className="h-5 w-5 shrink-0 text-clay-500" />
      ) : null}
    </article>
  );
}

function TimelineLoading({ who }: { who: string }): ReactElement {
  const subject = who.length > 0 ? `${who}'s` : 'your';
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div
        role="status"
        aria-live="polite"
        aria-busy
        className="font-body text-base text-text-secondary"
      >
        {`Gathering ${subject} memories…`}
      </div>
      <div aria-hidden className="flex flex-col gap-3">
        {[0, 1, 2, 3].map((key) => (
          <div
            key={key}
            style={{ height: ROW_HEIGHT - 12 }}
            className={cx(
              'flex items-center gap-4 rounded-lg border border-border-subtle bg-surface-raised p-4',
            )}
          >
            <span className="h-16 w-16 shrink-0 rounded-md bg-surface-sunken" />
            <span className="flex flex-1 flex-col gap-2">
              <span className="h-4 w-1/2 rounded-full bg-surface-sunken" />
              <span className="h-3 w-1/3 rounded-full bg-surface-tinted" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
