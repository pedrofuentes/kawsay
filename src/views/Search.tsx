// The Search screen (Journey E; AC-6 search half + AC-7). A calm, forgiving way
// to find one memory by a few plain words, then narrow by type, source or date.
// The query is debounced and run through the typed `searchCatalog` bridge. The
// `source` filter is applied SERVER-SIDE — it travels with the request so the
// catalogue narrows the match set to one connector (AC-7) — while type and date
// stay client-side filters over the returned page (the result tiles carry
// `mediaType` + `captureDate`, so those we can narrow on honestly in memory).
//
// Everything the catalog returns is UNTRUSTED data (a loved one's words, captions,
// filenames). It is rendered as escaped React text — never markup — and the match
// highlight is built from plain string slices wrapped in <mark>, so a caption like
// "<script>…" can never become a live element (AC-4 posture; USER_FLOWS rubric R12).
// The `source` value is a validated enum, shown via the shared source set.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { ItemCardDTO, MediaType, SearchResultDTO, SourceType } from '@shared/kawsay-api';
import { Button } from '@renderer/components/Button';
import { EmptyState } from '@renderer/components/EmptyState';
import { ErrorBanner } from '@renderer/components/ErrorBanner';
import { Icon } from '@renderer/components/Icon';
import type { IconName } from '@renderer/components/Icon';
import { SOURCES, getSource } from '@renderer/onboarding/sources';
import { cx } from '@renderer/lib/cx';
import { useKawsayApi } from '@renderer/lib/kawsay-api';
import { useLibrary } from '@renderer/lib/library';

/** Quiet pause after the last keystroke before a search runs (USER_FLOWS §E). */
const SEARCH_DEBOUNCE_MS = 200;
/** A calm page size — the top matches, never an overwhelming wall. */
const SEARCH_LIMIT = 50;

type Phase = 'idle' | 'searching' | 'error';

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

/** Day-precision `YYYY-MM-DD` key for lexical range compares, or `null`. */
function dayKey(iso: string | null): string | null {
  if (iso === null) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

/** The caption to show for a result — title, then description, then a gentle fallback. */
function captionOf(item: ItemCardDTO): string {
  const text = item.title ?? item.description;
  if (text !== null && text.trim() !== '') return text;
  return `${TYPE_META[item.mediaType].label} memory`;
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
  const [result, setResult] = useState<SearchResultDTO | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  // Monotonic request id so a slow earlier search can never overwrite a newer one.
  const requestId = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Re-orient keyboard and screen-reader users to the screen heading on entry.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (query === '') {
      requestId.current += 1;
      setResult(null);
      setPhase('idle');
      return;
    }
    if (api === undefined) {
      // Browser preview without the preload bridge — stay calm, do nothing.
      return;
    }
    const id = (requestId.current += 1);
    setPhase('searching');
    api
      .searchCatalog({
        query,
        limit: SEARCH_LIMIT,
        // The source filter is server-side: send it only when a connector is chosen.
        ...(activeSource !== null ? { source: activeSource } : {}),
      })
      .then((page) => {
        if (id !== requestId.current) return;
        setResult(page);
        setPhase('idle');
      })
      .catch(() => {
        if (id !== requestId.current) return;
        setPhase('error');
      });
  }, [api, query, activeSource, retryToken]);

  const visibleItems = useMemo<ItemCardDTO[]>(() => {
    if (result === null) return [];
    return result.items.filter((item) => {
      if (activeTypes.size > 0 && !activeTypes.has(item.mediaType)) return false;
      if (fromDate !== '' || toDate !== '') {
        const day = dayKey(item.captureDate);
        if (day === null) return false;
        if (fromDate !== '' && day < fromDate) return false;
        if (toDate !== '' && day > toDate) return false;
      }
      return true;
    });
  }, [result, activeTypes, fromDate, toDate]);

  const hasQuery = query !== '';
  const hasRawResults = result !== null && result.items.length > 0;
  const filtersActive =
    activeTypes.size > 0 || activeSource !== null || fromDate !== '' || toDate !== '';

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
    if (!hasRawResults) return 'No memories found';
    const count = visibleItems.length;
    return `${count} ${count === 1 ? 'memory' : 'memories'} found`;
  }, [hasQuery, phase, hasRawResults, query, visibleItems.length]);

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
    if (result === null) {
      return (
        <p className="font-body text-base text-text-secondary">Looking through the memories…</p>
      );
    }

    if (!hasRawResults) {
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

    if (visibleItems.length === 0) {
      return (
        <EmptyState
          icon={<Icon name="search" className="h-8 w-8" />}
          title="No memories match these filters"
          description="Try removing a filter to see more of what you searched for. The “Clear filters” button above brings them all back."
        />
      );
    }

    return (
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {visibleItems.map((item) => (
          <li key={item.id}>
            <ResultCard item={item} term={query} />
          </li>
        ))}
      </ul>
    );
  }
}

function ResultCard({ item, term }: { item: ItemCardDTO; term: string }): ReactElement {
  const meta = TYPE_META[item.mediaType];
  const date = formatDate(item.captureDate);
  // Provenance label, drawn from the shared source set; null when no source survives.
  const sourceMeta = item.source !== null ? getSource(item.source) : null;
  return (
    <article className="flex h-full flex-col gap-3 rounded-lg border border-border-subtle bg-surface-raised p-6">
      {/* Lazy media affordance: until a local-protocol thumbnail reference exists in
          the catalog DTO, results show a calm type tile rather than reaching out for
          a file — keeping the renderer free of any network or filesystem coupling. */}
      <div
        aria-hidden
        className="flex aspect-[4/3] items-center justify-center rounded-md bg-surface-sunken text-sage-600"
      >
        <Icon name={meta.icon} className="h-9 w-9" />
      </div>
      <p className="font-body text-base text-text-primary">{highlight(captionOf(item), term)}</p>
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
    </article>
  );
}
