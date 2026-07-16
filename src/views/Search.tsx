// The Search screen (Journey E; AC-6 search half + AC-7). A calm, forgiving way
// to find one memory by a few plain words, then narrow by type, source or date.
// The query is debounced and run through the typed `searchCatalog` bridge. EVERY
// filter — connector `source` (AC-7), media `types`, and the `from`/`to` day-range —
// is applied SERVER-SIDE: each travels with the request so the catalogue narrows the
// WHOLE library, not just the first page (#431). So a memory matching the query and
// the filters is findable however it ranks, the count is the true filtered total, and
// a gentle "show more" pages through the rest by offset rather than hiding them.
//
// Everything the catalog returns is UNTRUSTED data (a loved one's words, captions,
// filenames). It is rendered as escaped React text — never markup — and the match
// highlight is built from plain string slices wrapped in <mark>, so a caption like
// "<script>…" can never become a live element (AC-4 posture; USER_FLOWS rubric R12).
// The `source` value is a validated enum, shown via the shared source set.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { ItemCardDTO, MediaType, SourceType } from '@shared/kawsay-api';
import { Button } from '@renderer/components/Button';
import { EmptyState } from '@renderer/components/EmptyState';
import { ErrorBanner } from '@renderer/components/ErrorBanner';
import { Icon } from '@renderer/components/Icon';
import type { IconName } from '@renderer/components/Icon';
import { MediaThumbnail } from '@renderer/components/MediaThumbnail';
import { SOURCES, getSource } from '@renderer/onboarding/sources';
import { cx } from '@renderer/lib/cx';
import { useKawsayApi } from '@renderer/lib/kawsay-api';
import { useLibrary } from '@renderer/lib/library';
import { useNavigation } from '@renderer/lib/navigation';

/** Quiet pause after the last keystroke before a search runs (USER_FLOWS §E). */
const SEARCH_DEBOUNCE_MS = 200;
/** A calm page size — the top matches, never an overwhelming wall. */
const SEARCH_LIMIT = 50;

type Phase = 'idle' | 'searching' | 'loadingMore' | 'error';

interface TypeMeta {
  /** Singular label shown on a result ("Voice note"). */
  readonly label: string;
  /** Plural label shown on a filter chip ("Voice notes"). */
  readonly chipLabel: string;
  readonly icon: IconName;
}

const TYPE_META: Record<MediaType, TypeMeta> = {
  photo: { label: 'Photo', chipLabel: 'Photos', icon: 'photos' },
  video: { label: 'Video', chipLabel: 'Videos', icon: 'video' },
  audio: { label: 'Voice note', chipLabel: 'Voice notes', icon: 'audio' },
  document: { label: 'Document', chipLabel: 'Documents', icon: 'document' },
  message: { label: 'Message', chipLabel: 'Messages', icon: 'messages' },
};

const TYPE_ORDER: readonly MediaType[] = ['photo', 'video', 'audio', 'document', 'message'];

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
  return `${TYPE_META[item.mediaType].label} memory`;
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

/**
 * Wrap each case-insensitive occurrence of `term` in `<mark>`. Built entirely
 * from string slices rendered as React children, so the output is always escaped
 * text — there is no path here that could interpret untrusted markup.
 */
function highlight(text: string, term: string): ReactNode {
  const needle = term.trim();
  if (needle === '') return text;
  const haystack = text.toLowerCase();
  const lowered = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (;;) {
    const at = haystack.indexOf(lowered, cursor);
    if (at === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(
      <mark key={key} className="rounded-sm bg-parchment-300 px-0.5 text-text-primary">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    key += 1;
    cursor = at + needle.length;
  }
  return parts;
}

/** Local debounce — a few lines, no dependency (USER_FLOWS §E; AGENTS no-new-deps). */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  // nosemgrep: semgrep.semgrep-rules.typescript.react.best-practice.react-props-in-state -- debounce intentionally delays mirroring the input value.
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export function Search(): ReactElement {
  const api = useKawsayApi();
  const { library } = useLibrary();
  const who = library?.name ?? null;

  const headingId = useId();
  const inputId = useId();
  const hintId = useId();

  const [rawQuery, setRawQuery] = useState('');
  const debouncedQuery = useDebouncedValue(rawQuery, SEARCH_DEBOUNCE_MS);
  // Typing is debounced, but clearing the box resets instantly — an empty query
  // should never wait on the debounce to bring the gentle starting prompt back.
  const query = rawQuery.trim() === '' ? '' : debouncedQuery.trim();

  const [activeTypes, setActiveTypes] = useState<ReadonlySet<MediaType>>(() => new Set());
  const [activeSource, setActiveSource] = useState<SourceType | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const [phase, setPhase] = useState<Phase>('idle');
  // The results ACCUMULATE across pages: a fresh search replaces the list at offset 0,
  // and "show more" appends the next page — so nothing already found ever disappears.
  const [items, setItems] = useState<ItemCardDTO[]>([]);
  // The TRUE filtered total the catalogue reports, so the count and the "show more"
  // affordance reflect the whole library, not just the page on screen (#431).
  const [total, setTotal] = useState(0);
  // Whether the CURRENT query+filters have produced at least one response — so an
  // empty state (vs the calm "looking…" placeholder) appears only once it answers.
  const [loaded, setLoaded] = useState(false);
  // A "show more" that failed — kept SEPARATE from the initial-search error so a failed
  // page never wipes the memories already gathered: the loaded results stay on screen
  // and a gentle inline retry resumes from the current offset (nothing is ever lost).
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  // Monotonic request id so a slow earlier search — or a stale "show more" — can never
  // overwrite a newer one.
  const requestId = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The active media types in a stable display order, sent to the catalogue so the
  // WHOLE library is narrowed by type, not just the page already on screen (#431).
  const typesList = useMemo(() => TYPE_ORDER.filter((type) => activeTypes.has(type)), [activeTypes]);

  // Re-orient keyboard and screen-reader users to the screen heading on entry.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // A fresh search whenever the query OR any filter changes. Previous results stay on
  // screen until the new first page resolves (no flash), then REPLACE the list.
  useEffect(() => {
    if (query === '') {
      requestId.current += 1;
      setItems([]);
      setTotal(0);
      setLoaded(false);
      setLoadMoreFailed(false);
      setPhase('idle');
      return;
    }
    if (api === undefined) {
      // Browser preview without the preload bridge — stay calm, do nothing.
      return;
    }
    const id = (requestId.current += 1);
    setLoaded(false);
    setLoadMoreFailed(false);
    setPhase('searching');
    api
      .searchCatalog({
        query,
        limit: SEARCH_LIMIT,
        // Every filter is server-side: each travels only when set, so an unfiltered
        // call stays a plain { query, limit } and the catalogue narrows the whole set.
        ...(activeSource !== null ? { source: activeSource } : {}),
        ...(typesList.length > 0 ? { types: typesList } : {}),
        ...(fromDate !== '' ? { fromDate } : {}),
        ...(toDate !== '' ? { toDate } : {}),
      })
      .then((page) => {
        if (id !== requestId.current) return;
        setItems(page.items);
        setTotal(page.total);
        setLoaded(true);
        setPhase('idle');
      })
      .catch(() => {
        if (id !== requestId.current) return;
        setPhase('error');
      });
  }, [api, query, activeSource, typesList, fromDate, toDate, retryToken]);

  const hasQuery = query !== '';
  const hasResults = items.length > 0;
  // There is more of the filtered set beyond what is on screen (#431).
  const hasMore = loaded && items.length < total;
  const filtersActive =
    activeTypes.size > 0 || activeSource !== null || fromDate !== '' || toDate !== '';

  // Fetch and APPEND the next page (by offset) within the SAME search — a no-op while a
  // page is already in flight, or once the whole filtered set is on screen. Every call
  // BUMPS the monotonic request id and captures it, so two rapid "show more" clicks
  // (a same-tick double-click) can't both append: the earlier response is stale and
  // dropped, leaving exactly one page appended (#456).
  const loadMore = useCallback(() => {
    if (api === undefined || phase === 'searching' || phase === 'loadingMore') return;
    if (items.length >= total) return;
    const id = (requestId.current += 1);
    const offset = items.length;
    setLoadMoreFailed(false);
    setPhase('loadingMore');
    api
      .searchCatalog({
        query,
        limit: SEARCH_LIMIT,
        offset,
        ...(activeSource !== null ? { source: activeSource } : {}),
        ...(typesList.length > 0 ? { types: typesList } : {}),
        ...(fromDate !== '' ? { fromDate } : {}),
        ...(toDate !== '' ? { toDate } : {}),
      })
      .then((page) => {
        if (id !== requestId.current) return;
        setItems((prev) => [...prev, ...page.items]);
        setTotal(page.total);
        setPhase('idle');
      })
      .catch(() => {
        if (id !== requestId.current) return;
        // Preserve everything already gathered: return to idle (the results stay on
        // screen) and raise an INLINE retry that resumes from this same offset — never
        // the full-page error, which would wipe a deep scroll (#456).
        setPhase('idle');
        setLoadMoreFailed(true);
      });
  }, [api, phase, items.length, total, query, activeSource, typesList, fromDate, toDate]);

  const toggleType = useCallback((type: MediaType) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setActiveTypes(new Set());
    setActiveSource(null);
    setFromDate('');
    setToDate('');
  }, []);

  const clearSearch = useCallback(() => {
    setRawQuery('');
  }, []);

  const retry = useCallback(() => {
    setPhase('searching');
    setRetryToken((token) => token + 1);
  }, []);

  const statusText = useMemo(() => {
    if (!hasQuery) return '';
    if (phase === 'searching') return 'Searching…';
    if (phase === 'error') return '';
    if (!loaded) return '';
    if (total === 0) return 'No memories found';
    // The TRUE filtered total — even when only the first page is on screen (#431).
    return `${total} ${total === 1 ? 'memory' : 'memories'} found`;
  }, [hasQuery, phase, loaded, total]);

  const label = who !== null ? `Search ${who}'s memories` : 'Search the memories';

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-3xl font-semibold text-text-primary outline-none"
        >
          Search
        </h1>
        <p className="font-body text-base text-text-secondary">
          Look through everything gathered here by a few plain words.
        </p>
      </header>

      <form
        role="search"
        className="flex flex-col gap-5"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor={inputId} className="font-body text-base font-medium text-text-primary">
            {label}
          </label>
          <input
            id={inputId}
            type="search"
            value={rawQuery}
            onChange={(event) => setRawQuery(event.target.value)}
            aria-describedby={hintId}
            autoComplete="off"
            placeholder="A name, a place, a few words…"
            className="min-h-14 rounded-lg border border-border-interactive bg-surface-raised px-4 font-body text-md text-text-primary placeholder:text-text-secondary"
          />
          <p id={hintId} className="font-body text-sm text-text-secondary">
            Memories never leave this computer.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <div role="group" aria-label="Filter by type" className="flex flex-wrap gap-2">
            {TYPE_ORDER.map((type) => {
              const pressed = activeTypes.has(type);
              return (
                <button
                  key={type}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => toggleType(type)}
                  className={cx(
                    'inline-flex min-h-11 items-center gap-2 rounded-full border px-4 font-body text-base transition-colors duration-150',
                    pressed
                      ? 'border-sage-600 bg-sage-600 text-text-on-primary'
                      : 'border-border-default bg-surface-raised text-text-secondary hover:bg-surface-tinted',
                  )}
                >
                  <Icon name={TYPE_META[type].icon} className="h-4 w-4" />
                  {TYPE_META[type].chipLabel}
                </button>
              );
            })}
          </div>

          <div role="group" aria-label="Filter by source" className="flex flex-col gap-1">
            <label htmlFor={`${inputId}-source`} className="font-body text-sm text-text-secondary">
              Source
            </label>
            <select
              id={`${inputId}-source`}
              value={activeSource ?? ''}
              onChange={(event) =>
                setActiveSource(
                  event.target.value === '' ? null : (event.target.value as SourceType),
                )
              }
              className="min-h-11 w-full max-w-xs rounded-lg border border-border-default bg-surface-raised px-3 font-body text-base text-text-primary"
            >
              <option value="">All sources</option>
              {SOURCES.map((source) => (
                <option key={source.type} value={source.type}>
                  {source.title}
                </option>
              ))}
            </select>
          </div>

          <div role="group" aria-label="Filter by date" className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor={`${inputId}-from`} className="font-body text-sm text-text-secondary">
                From
              </label>
              <input
                id={`${inputId}-from`}
                type="date"
                value={fromDate}
                max={toDate === '' ? undefined : toDate}
                onChange={(event) => setFromDate(event.target.value)}
                className="min-h-11 rounded-lg border border-border-default bg-surface-raised px-3 font-body text-base text-text-primary"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={`${inputId}-to`} className="font-body text-sm text-text-secondary">
                To
              </label>
              <input
                id={`${inputId}-to`}
                type="date"
                value={toDate}
                min={fromDate === '' ? undefined : fromDate}
                onChange={(event) => setToDate(event.target.value)}
                className="min-h-11 rounded-lg border border-border-default bg-surface-raised px-3 font-body text-base text-text-primary"
              />
            </div>
            {filtersActive ? (
              <Button variant="ghost" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : null}
          </div>
        </div>

        <p role="status" aria-live="polite" className="min-h-5 font-body text-sm text-text-secondary">
          {statusText}
        </p>
      </form>

      <div>{renderBody()}</div>
    </section>
  );

  function renderBody(): ReactElement {
    if (phase === 'error') {
      return (
        <ErrorBanner
          title="We couldn't search just now"
          message="Something on this computer got in the way. Please try that search again — every memory is safe."
          onRetry={retry}
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
            <Button variant="secondary" onClick={clearSearch}>
              Clear search
            </Button>
          }
        />
      );
    }

    return (
      <div className="flex flex-col gap-6">
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {items.map((item) => (
            <li key={item.id}>
              <ResultCard item={item} term={query} />
            </li>
          ))}
        </ul>
        {renderShowMore()}
      </div>
    );
  }

  // A gentle way to reach the rest of the filtered set (#431): the count is always the
  // TRUE total, so a person sees how many memories are still waiting and can bring them
  // in a page at a time — never a silent truncation. A failed page keeps the memories
  // already gathered on screen and offers an inline retry that resumes here (#456).
  function renderShowMore(): ReactElement | null {
    if (!hasMore) return null;
    const loadingMore = phase === 'loadingMore';
    return (
      <div className="flex flex-col items-center gap-3">
        <p className="font-body text-sm text-text-secondary">
          Showing {items.length} of {total} memories
        </p>
        {loadMoreFailed ? (
          <p role="status" className="font-body text-sm text-text-secondary">
            We couldn&apos;t load more just now — every memory here is safe.
          </p>
        ) : null}
        <Button variant="secondary" onClick={loadMore} disabled={loadingMore} aria-busy={loadingMore}>
          {loadingMore
            ? 'Gathering more…'
            : loadMoreFailed
              ? 'Try again'
              : 'Show more memories'}
        </Button>
      </div>
    );
  }
}

function ResultCard({ item, term }: { item: ItemCardDTO; term: string }): ReactElement {
  const { navigate, view } = useNavigation();
  const meta = TYPE_META[item.mediaType];
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
        onClick={() => navigate({ name: 'item', item, from: view })}
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
