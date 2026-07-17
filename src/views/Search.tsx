// The Search screen (Journey E; AC-6 search half + AC-7). A calm, forgiving way
// to find one memory by a few plain words, then narrow by type, source or date.
// The query is debounced and run through the typed `searchCatalog` bridge. EVERY
// filter — connector `source` (AC-7), media `types`, and the `from`/`to` day-range —
// is applied SERVER-SIDE: each travels with the request so the catalogue narrows the
// WHOLE library, not just the first page (#431). So a memory matching the query and
// the filters is findable however it ranks, the count is the true filtered total, and
// a gentle "show more" pages through the rest by offset rather than hiding them.
//
// This file is the orchestrating container (#436): the debounce, dual filter
// models, race-guarding and status text live here, while the filter form and the
// result area are presentational pieces in ./search/. Everything the catalog
// returns is UNTRUSTED data (a loved one's words, captions, filenames) — see
// ./search/SearchResults for how it is kept to escaped text, never markup
// (AC-4 posture; USER_FLOWS rubric R12). The `source` value is a validated enum,
// shown via the shared source set.
//
// DEFERRED from the #486 read-hook migration: this data path (the fresh-search
// effect below plus `loadMore`'s page accumulator) is NOT yet migrated onto the
// `useInfiniteQuery`-style paginated primitive (#503). It carries the #456
// shared monotonic request id (one guard spanning BOTH a fresh search and
// "show more", so a stale response from either can't clobber a newer one) and
// is coupled to the #482 snapshot-consistent offset pagination on the IPC side —
// migrating it needs the accumulator variant to model both without regressing
// either. Tracked as a separate follow-up.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ItemCardDTO, MediaType, SourceType } from '@shared/kawsay-api';
import { Heading } from '@renderer/components/Heading';
import { pluralize } from '@renderer/lib/pluralize';
import { useAutoFocusHeading } from '@renderer/lib/use-auto-focus';
import { useKawsayApi } from '@renderer/lib/kawsay-api';
import { useLibrary } from '@renderer/lib/library';
import { MEDIA_TYPE_ORDER } from '@renderer/lib/media-meta';
import { SearchFilterBar } from './search/SearchFilterBar';
import { SearchResults } from './search/SearchResults';
import type { SearchPhase } from './search/SearchResults';

/** Quiet pause after the last keystroke before a search runs (USER_FLOWS §E). */
const SEARCH_DEBOUNCE_MS = 200;
/** A calm page size — the top matches, never an overwhelming wall. */
const SEARCH_LIMIT = 50;

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
  const headingRef = useAutoFocusHeading<HTMLHeadingElement>();

  const [rawQuery, setRawQuery] = useState('');
  const debouncedQuery = useDebouncedValue(rawQuery, SEARCH_DEBOUNCE_MS);
  // Typing is debounced, but clearing the box resets instantly — an empty query
  // should never wait on the debounce to bring the gentle starting prompt back.
  const query = rawQuery.trim() === '' ? '' : debouncedQuery.trim();

  const [activeTypes, setActiveTypes] = useState<ReadonlySet<MediaType>>(() => new Set());
  const [activeSource, setActiveSource] = useState<SourceType | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const [phase, setPhase] = useState<SearchPhase>('idle');
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
  const requestIdRef = useRef(0);

  // The active media types in a stable display order, sent to the catalogue so the
  // WHOLE library is narrowed by type, not just the page already on screen (#431).
  const typesList = useMemo(
    () => MEDIA_TYPE_ORDER.filter((type) => activeTypes.has(type)),
    [activeTypes],
  );

  // A fresh search whenever the query OR any filter changes. Previous results stay on
  // screen until the new first page resolves (no flash), then REPLACE the list.
  useEffect(() => {
    if (query === '') {
      requestIdRef.current += 1;
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
    const id = (requestIdRef.current += 1);
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
        if (id !== requestIdRef.current) return;
        setItems(page.items);
        setTotal(page.total);
        setLoaded(true);
        setPhase('idle');
      })
      .catch(() => {
        if (id !== requestIdRef.current) return;
        setPhase('error');
      });
  }, [api, query, activeSource, typesList, fromDate, toDate, retryToken]);

  const hasQuery = query !== '';
  const hasResults = items.length > 0;
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
    const id = (requestIdRef.current += 1);
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
        if (id !== requestIdRef.current) return;
        setItems((prev) => [...prev, ...page.items]);
        setTotal(page.total);
        setPhase('idle');
      })
      .catch(() => {
        if (id !== requestIdRef.current) return;
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
    return `${total} ${pluralize(total, 'memory', 'memories')} found`;
  }, [hasQuery, phase, loaded, total]);

  const label = who !== null ? `Search ${who}'s memories` : 'Search the memories';

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <Heading id={headingId} headingRef={headingRef}>
          Search
        </Heading>
        <p className="font-body text-base text-text-secondary">
          Look through everything gathered here by a few plain words.
        </p>
      </header>

      <SearchFilterBar
        inputId={inputId}
        hintId={hintId}
        label={label}
        rawQuery={rawQuery}
        onQueryChange={setRawQuery}
        activeTypes={activeTypes}
        onToggleType={toggleType}
        activeSource={activeSource}
        onSourceChange={setActiveSource}
        fromDate={fromDate}
        onFromDateChange={setFromDate}
        toDate={toDate}
        onToDateChange={setToDate}
        filtersActive={filtersActive}
        onClearFilters={clearFilters}
        statusText={statusText}
      />

      <div>
        <SearchResults
          phase={phase}
          hasQuery={hasQuery}
          loaded={loaded}
          hasResults={hasResults}
          filtersActive={filtersActive}
          query={query}
          items={items}
          total={total}
          loadMoreFailed={loadMoreFailed}
          onRetry={retry}
          onClearSearch={clearSearch}
          onLoadMore={loadMore}
        />
      </div>
    </section>
  );
}
