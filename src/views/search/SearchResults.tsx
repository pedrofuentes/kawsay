// Extracted from Search.tsx (#436) — the result area: the calm empty/loading/
// error faces, the result grid, the transcript-match hint (AC-19), and the
// server-side "show more" affordance (#431) with its inline failed-page retry
// (#456). Everything the catalog returns is UNTRUSTED data (a loved one's
// words, captions, filenames); it is rendered as escaped React text — never
// markup — via the shared `highlight` util (AC-4 posture; USER_FLOWS rubric R12).
import type { ReactElement } from 'react';
import type { ItemCardDTO } from '@shared/kawsay-api';
import { Button } from '@renderer/components/Button';
import { EmptyState } from '@renderer/components/EmptyState';
import { ErrorBanner } from '@renderer/components/ErrorBanner';
import { Icon } from '@renderer/components/Icon';
import { MediaThumbnail } from '@renderer/components/MediaThumbnail';
import { highlight } from '@renderer/lib/highlight';
import { MEDIA_META } from '@renderer/lib/media-meta';
import { getSource } from '@renderer/onboarding/sources';
import { useNavigation } from '@renderer/lib/navigation';

export type SearchPhase = 'idle' | 'searching' | 'loadingMore' | 'error';

export interface SearchResultsProps {
  phase: SearchPhase;
  hasQuery: boolean;
  loaded: boolean;
  hasResults: boolean;
  filtersActive: boolean;
  query: string;
  items: ItemCardDTO[];
  total: number;
  loadMoreFailed: boolean;
  onRetry: () => void;
  onClearSearch: () => void;
  onLoadMore: () => void;
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** Format an ISO capture date for reading, or `null` if absent/unparseable. */
function formatDate(iso: string | null): string | null {
  if (iso === null) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return DATE_FORMAT.format(new Date(time));
}

/** The caption to show for a result — title, then description, then a gentle fallback. */
function captionOf(item: ItemCardDTO): string {
  const text = item.title ?? item.description;
  if (text !== null && text.trim() !== '') return text;
  return `${MEDIA_META[item.mediaType].label} memory`;
}

/**
 * Did this audio/video result surface because the term was in its TRANSCRIPT, not
 * its visible caption? The catalog FTS indexes transcript text into `search_meta`
 * (#135), so a recording can match a word that is nowhere in its title/description.
 * When that happens we add a gentle "found in what was said" hint (AC-19) so the
 * person understands why a silent-looking tile answered a text search. Only
 * audio/video carry words; for everything else this is always false.
 */
function matchedInTranscript(item: ItemCardDTO, term: string): boolean {
  if (item.mediaType !== 'audio' && item.mediaType !== 'video') return false;
  const needle = term.trim().toLowerCase();
  if (needle === '') return false;
  const inTitle = (item.title ?? '').toLowerCase().includes(needle);
  const inDescription = (item.description ?? '').toLowerCase().includes(needle);
  return !inTitle && !inDescription;
}

export function SearchResults({
  phase,
  hasQuery,
  loaded,
  hasResults,
  filtersActive,
  query,
  items,
  total,
  loadMoreFailed,
  onRetry,
  onClearSearch,
  onLoadMore,
}: SearchResultsProps): ReactElement {
  if (phase === 'error') {
    return (
      <ErrorBanner
        title="We couldn't search just now"
        message="Something on this computer got in the way. Please try that search again — every memory is safe."
        onRetry={onRetry}
        retryLabel="Try again"
      />
    );
  }

  if (!hasQuery) {
    return (
      <EmptyState
        icon={<Icon name="search" className="h-8 w-8" />}
        title="Start typing to search"
        description="Type a name, a place, or a few words — whatever you remember — and the memories that match will gather here."
      />
    );
  }

  // A first search is still in flight and there is nothing prior to keep on screen.
  if (!loaded && !hasResults) {
    return (
      <p className="font-body text-base text-text-secondary">Looking through the memories…</p>
    );
  }

  // The catalogue has answered with nothing. A filtered miss and an outright miss
  // read differently: one gently points at the filters, the other at the words.
  if (loaded && !hasResults) {
    if (filtersActive) {
      return (
        <EmptyState
          icon={<Icon name="search" className="h-8 w-8" />}
          title="No memories match these filters"
          description="Try removing a filter to see more of what you searched for. The “Clear filters” button above brings them all back."
        />
      );
    }
    return (
      <EmptyState
        icon={<Icon name="search" className="h-8 w-8" />}
        title={`We couldn't find anything for “${query}”`}
        description="Try fewer words, or a different spelling. Every memory is still here."
        action={
          <Button variant="secondary" onClick={onClearSearch}>
            Clear search
          </Button>
        }
      />
    );
  }

  // There is more of the filtered set beyond what is on screen (#431).
  const hasMore = loaded && items.length < total;
  const loadingMore = phase === 'loadingMore';

  return (
    <div className="flex flex-col gap-6">
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.id}>
            <ResultCard item={item} term={query} siblings={items} />
          </li>
        ))}
      </ul>
      {/* A gentle way to reach the rest of the filtered set (#431): the count is
          always the TRUE total, so a person sees how many memories are still
          waiting and can bring them in a page at a time — never a silent
          truncation. A failed page keeps the memories already gathered on screen
          and offers an inline retry that resumes here (#456). */}
      {hasMore ? (
        <div className="flex flex-col items-center gap-3">
          <p className="font-body text-sm text-text-secondary">
            Showing {items.length} of {total} memories
          </p>
          {loadMoreFailed ? (
            <p role="status" className="font-body text-sm text-text-secondary">
              We couldn&apos;t load more just now — every memory here is safe.
            </p>
          ) : null}
          <Button
            variant="secondary"
            onClick={onLoadMore}
            disabled={loadingMore}
            aria-busy={loadingMore}
          >
            {loadingMore ? 'Gathering more…' : loadMoreFailed ? 'Try again' : 'Show more memories'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// `siblings` is the current (already-filtered) result set — passed straight
// through so ←/→ in ItemView can step to the previous/next result in the same
// order shown here, without any re-fetch or new IPC channel (#434).
function ResultCard({
  item,
  term,
  siblings,
}: {
  item: ItemCardDTO;
  term: string;
  siblings: ItemCardDTO[];
}): ReactElement {
  const { navigate, view } = useNavigation();
  const meta = MEDIA_META[item.mediaType];
  const date = formatDate(item.captureDate);
  // Provenance label, drawn from the shared source set; null when no source survives.
  const sourceMeta = item.source !== null ? getSource(item.source) : null;
  const caption = captionOf(item);
  const transcriptMatch = matchedInTranscript(item, term);
  return (
    <article className="flex h-full flex-col gap-3 rounded-lg border border-border-subtle bg-surface-raised p-6">
      {/* The whole result is one button that opens the memory on its own view. */}
      <button
        type="button"
        onClick={() => navigate({ name: 'item', item, from: view, siblings })}
        aria-label={`Open ${caption}`}
        className="flex flex-col gap-3 rounded-md text-left"
      >
        {/* Lazy media tile: a real thumbnail for a renderable result, fetched by
            OPAQUE id over the zero-egress `catalog:thumbnail` channel, with the calm
            type icon as the fallback while loading, on error, or for non-visual items
            — so the renderer still reaches for no file path and no network. */}
        <MediaThumbnail
          item={item}
          icon={meta.icon}
          className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md bg-surface-sunken text-sage-600"
          iconClassName="h-9 w-9"
        />
        <p className="font-body text-base text-text-primary">{highlight(caption, term)}</p>
        <p className="flex flex-wrap items-center gap-x-2 font-body text-sm text-text-secondary">
          <span>{meta.label}</span>
          {date !== null ? (
            <>
              <span aria-hidden>·</span>
              <span>{date}</span>
            </>
          ) : null}
          {sourceMeta !== null ? (
            <>
              <span aria-hidden>·</span>
              <span>{sourceMeta.title}</span>
            </>
          ) : null}
        </p>
      </button>
      {/* AC-19: this recording matched on its spoken words, not its caption — say so
          gently so the person isn't puzzled by a "silent" tile in a text search. */}
      {transcriptMatch ? (
        <p className="inline-flex items-center gap-1.5 font-body text-sm text-text-secondary">
          <Icon name="audio" className="h-4 w-4 shrink-0 text-sage-600" />
          Found in what was said
        </p>
      ) : null}
    </article>
  );
}
