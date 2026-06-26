import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Search } from '@renderer/views/Search';
import { MainApp } from '@renderer/app/MainApp';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { LibraryProvider } from '@renderer/lib/library';
import { NavigationProvider } from '@renderer/lib/navigation';
import { makeFakeApi, makeItemCard, makeSearchResult } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { renderWithProviders, ViewProbe, wrapInProviders } from './support/render';

/** Render the Search view inside the three renderer providers with a fake bridge. */
function renderSearch(api: FakeApi = makeFakeApi()) {
  const user = userEvent.setup();
  const utils = render(wrapInProviders(<Search />, api, { name: 'search' }));
  return { api, user, ...utils };
}

/**
 * Match a result caption by its full visible text, tolerant of the inline
 * <mark> elements the view wraps around matched terms — the term highlight
 * splits the caption into several text nodes, so a plain string match misses.
 */
function caption(text: string) {
  return (_content: string, node: Element | null): boolean =>
    node !== null && node.tagName === 'P' && node.textContent === text;
}

describe('Search — the search box and querying', () => {
  it('renders a labelled search box inside a search landmark, prompting before any query', () => {
    const { api } = renderSearch();
    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeInTheDocument();
    // A warm prompt to begin — never a cold empty screen.
    expect(screen.getByText(/a few words/i)).toBeInTheDocument();
    // Nothing is queried until the person actually types.
    expect(api.searchCatalog).not.toHaveBeenCalled();
  });

  it('debounces typing and issues a single search for the final query, with a bounded limit', async () => {
    vi.useFakeTimers();
    try {
      const api = makeFakeApi({
        searchCatalog: vi.fn(() => Promise.resolve(makeSearchResult())),
      });
      render(wrapInProviders(<Search />, api, { name: 'search' }));

      // Several keystrokes land inside one debounce window. fireEvent (not
      // userEvent) is used deliberately: userEvent's keyboard loop deadlocks
      // against vi's fake timers, and all we need to prove here is that rapid
      // edits coalesce into a single, final-query search.
      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: 'm' } });
      fireEvent.change(input, { target: { value: 'ma' } });
      fireEvent.change(input, { target: { value: 'mam' } });
      fireEvent.change(input, { target: { value: 'mama' } });
      // Still within the debounce window: no thrashing of the catalog per keystroke.
      expect(api.searchCatalog).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });

      expect(api.searchCatalog).toHaveBeenCalledTimes(1);
      expect(api.searchCatalog).toHaveBeenCalledWith({ query: 'mama', limit: 50 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders matching results with a caption, a readable date, and a type label', async () => {
    const api = makeFakeApi({
      searchCatalog: vi.fn(() =>
        Promise.resolve(
          makeSearchResult({
            items: [
              makeItemCard({
                mediaType: 'photo',
                title: 'Beach picnic',
                captureDate: '2019-06-15T10:00:00.000Z',
              }),
            ],
          }),
        ),
      ),
    });
    const { user } = renderSearch(api);

    await user.type(screen.getByRole('searchbox'), 'beach');

    expect(await screen.findByText(caption('Beach picnic'))).toBeInTheDocument();
    expect(screen.getByText(/2019/)).toBeInTheDocument();
    expect(screen.getByText(/^photo$/i)).toBeInTheDocument();
  });

  it('falls back to the description as the caption when an item has no title', async () => {
    const api = makeFakeApi({
      searchCatalog: vi.fn(() =>
        Promise.resolve(
          makeSearchResult({
            items: [makeItemCard({ title: null, description: 'A note about the garden' })],
          }),
        ),
      ),
    });
    const { user } = renderSearch(api);

    await user.type(screen.getByRole('searchbox'), 'garden');

    expect(await screen.findByText(caption('A note about the garden'))).toBeInTheDocument();
  });

  it('announces the number of results through a polite live region', async () => {
    const api = makeFakeApi({
      searchCatalog: vi.fn(() =>
        Promise.resolve(
          makeSearchResult({
            items: [makeItemCard({ title: 'One' }), makeItemCard({ title: 'Two' })],
          }),
        ),
      ),
    });
    const { user } = renderSearch(api);

    await user.type(screen.getByRole('searchbox'), 'thing');

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/2 memories/i));
  });
});

describe('Search — empty, loading and error states', () => {
  it('shows a warm not-found state naming the term, and "Clear search" returns to the prompt', async () => {
    const api = makeFakeApi({
      searchCatalog: vi.fn(() => Promise.resolve(makeSearchResult({ items: [], total: 0 }))),
    });
    const { user } = renderSearch(api);

    await user.type(screen.getByRole('searchbox'), 'zzz');

    expect(await screen.findByText(/couldn't find anything for/i)).toBeInTheDocument();
    expect(screen.getByText(/zzz/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /clear search/i }));

    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByText(/a few words/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't find anything for/i)).not.toBeInTheDocument();
  });

  it('keeps previous results visible while a new search loads and shows a searching status', async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce(makeSearchResult({ items: [makeItemCard({ title: 'Beach picnic' })] }))
      .mockReturnValue(new Promise(() => {}));
    const api = makeFakeApi({ searchCatalog: search });
    const { user } = renderSearch(api);

    const input = screen.getByRole('searchbox');
    await user.type(input, 'beach');
    expect(await screen.findByText(caption('Beach picnic'))).toBeInTheDocument();

    // Append more text → a second, slow search. Old results must not flash away.
    await user.type(input, ' party');

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/searching/i));
    expect(screen.getByText(caption('Beach picnic'))).toBeInTheDocument();
  });

  it('surfaces a gentle error (never a raw code) and a Try again that re-runs the search', async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(new Error('SQLITE_ERROR: fts5: syntax error near ")"'))
      .mockResolvedValue(makeSearchResult({ items: [makeItemCard({ title: 'Found it' })] }));
    const api = makeFakeApi({ searchCatalog: search });
    const { user } = renderSearch(api);

    await user.type(screen.getByRole('searchbox'), 'mama');

    const alert = await screen.findByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(screen.queryByText(/SQLITE|fts5|syntax error/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText(caption('Found it'))).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not crash when the kawsay bridge is absent (browser preview)', async () => {
    const user = userEvent.setup();
    render(
      <KawsayApiProvider api={undefined}>
        <LibraryProvider>
          <NavigationProvider initialView={{ name: 'search' }}>
            <Search />
          </NavigationProvider>
        </LibraryProvider>
      </KawsayApiProvider>,
    );

    const input = screen.getByRole('searchbox');
    await user.type(input, 'mama');
    expect(input).toBeInTheDocument();
  });
});

describe('Search — filters narrow the matches', () => {
  function twoTypedItems() {
    return makeSearchResult({
      items: [
        makeItemCard({ mediaType: 'photo', title: 'Beach picnic' }),
        makeItemCard({ mediaType: 'video', title: 'Birthday clip' }),
      ],
    });
  }

  it('narrows results by media type and exposes pressed state on the active chip', async () => {
    const api = makeFakeApi({ searchCatalog: vi.fn(() => Promise.resolve(twoTypedItems())) });
    const { user } = renderSearch(api);

    await user.type(screen.getByRole('searchbox'), 'b');
    expect(await screen.findByText(caption('Beach picnic'))).toBeInTheDocument();
    expect(screen.getByText(caption('Birthday clip'))).toBeInTheDocument();

    const videos = screen.getByRole('button', { name: /videos/i });
    expect(videos).toHaveAttribute('aria-pressed', 'false');
    await user.click(videos);

    expect(videos).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(caption('Birthday clip'))).toBeInTheDocument();
    expect(screen.queryByText(caption('Beach picnic'))).not.toBeInTheDocument();
  });

  it('groups the type filters under an accessible group label', async () => {
    const api = makeFakeApi({ searchCatalog: vi.fn(() => Promise.resolve(twoTypedItems())) });
    renderSearch(api);
    expect(screen.getByRole('group', { name: /type/i })).toBeInTheDocument();
  });

  it('narrows results by date range', async () => {
    const api = makeFakeApi({
      searchCatalog: vi.fn(() =>
        Promise.resolve(
          makeSearchResult({
            items: [
              makeItemCard({ title: 'June memory', captureDate: '2019-06-15T10:00:00.000Z' }),
              makeItemCard({ title: 'January memory', captureDate: '2020-01-10T10:00:00.000Z' }),
            ],
          }),
        ),
      ),
    });
    const { user } = renderSearch(api);

    await user.type(screen.getByRole('searchbox'), 'memory');
    expect(await screen.findByText(caption('June memory'))).toBeInTheDocument();
    expect(screen.getByText(caption('January memory'))).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: '2020-01-01' } });

    expect(screen.getByText(caption('January memory'))).toBeInTheDocument();
    expect(screen.queryByText(caption('June memory'))).not.toBeInTheDocument();
  });

  it('shows a "no matches for these filters" state with a way to clear them', async () => {
    const api = makeFakeApi({ searchCatalog: vi.fn(() => Promise.resolve(twoTypedItems())) });
    const { user } = renderSearch(api);

    await user.type(screen.getByRole('searchbox'), 'b');
    expect(await screen.findByText(caption('Beach picnic'))).toBeInTheDocument();

    // Filter to a type neither result has → every match is hidden.
    await user.click(screen.getByRole('button', { name: /voice notes/i }));

    expect(await screen.findByText(/match these filters/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /clear filters/i }));

    expect(screen.getByText(caption('Beach picnic'))).toBeInTheDocument();
    expect(screen.getByText(caption('Birthday clip'))).toBeInTheDocument();
  });
});

describe('Search — the source filter narrows server-side (AC-7)', () => {
  it('groups a source filter under an accessible label, defaulting to all sources', () => {
    const api = makeFakeApi({ searchCatalog: vi.fn(() => Promise.resolve(makeSearchResult())) });
    renderSearch(api);
    const sourceFilter = screen.getByRole('combobox', { name: /source/i });
    expect(sourceFilter).toBeInTheDocument();
    // "All sources" is the resting state — no connector is pre-selected.
    expect(sourceFilter).toHaveValue('');
    expect(screen.getByRole('group', { name: /source/i })).toBeInTheDocument();
  });

  it('re-runs the search through the bridge for the chosen connector, and "All sources" clears it', async () => {
    const api = makeFakeApi({ searchCatalog: vi.fn(() => Promise.resolve(makeSearchResult())) });
    const { user } = renderSearch(api);

    await user.type(screen.getByRole('searchbox'), 'mama');
    await waitFor(() => expect(api.searchCatalog).toHaveBeenCalledWith({ query: 'mama', limit: 50 }));

    // Choosing a connector narrows the search server-side (a real searchCatalog param).
    await user.selectOptions(screen.getByRole('combobox', { name: /source/i }), 'whatsapp');
    await waitFor(() =>
      expect(api.searchCatalog).toHaveBeenLastCalledWith({
        query: 'mama',
        limit: 50,
        source: 'whatsapp',
      }),
    );

    // Returning to "All sources" drops the filter again.
    await user.selectOptions(screen.getByRole('combobox', { name: /source/i }), '');
    await waitFor(() =>
      expect(api.searchCatalog).toHaveBeenLastCalledWith({ query: 'mama', limit: 50 }),
    );
  });

  it('shows where each result came from', async () => {
    const api = makeFakeApi({
      searchCatalog: vi.fn(() =>
        Promise.resolve(
          makeSearchResult({ items: [makeItemCard({ title: 'Beach picnic', source: 'whatsapp' })] }),
        ),
      ),
    });
    const { user } = renderSearch(api);

    await user.type(screen.getByRole('searchbox'), 'beach');
    expect(await screen.findByText(caption('Beach picnic'))).toBeInTheDocument();
    // The result names its connector provenance, drawn from the shared source set.
    expect(screen.getByRole('article')).toHaveTextContent(/whatsapp/i);
  });
});

describe('Search — untrusted catalog data is rendered safely', () => {
  it('renders a caption containing markup as escaped text and highlights matches without injection', async () => {
    const api = makeFakeApi({
      searchCatalog: vi.fn(() =>
        Promise.resolve(
          makeSearchResult({
            items: [makeItemCard({ title: 'Mama <script>alert(1)</script>' })],
          }),
        ),
      ),
    });
    const { user, container } = renderSearch(api);

    await user.type(screen.getByRole('searchbox'), 'mama');

    // The markup is shown verbatim as text, never parsed into a live element.
    expect(await screen.findByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();

    // The matched term is highlighted, and the highlight is plain text too.
    const mark = container.querySelector('mark');
    expect(mark).not.toBeNull();
    expect(mark).toHaveTextContent('Mama');
  });
});

describe('Search — wiring into the main app', () => {
  it('MainApp shows the Search view for the search section, replacing the placeholder', () => {
    renderWithProviders(<MainApp />, { initialView: { name: 'search' } });
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
    expect(screen.queryByText(/on its way/i)).not.toBeInTheDocument();
  });
});

describe('Search — a transcript match is made clear (AC-19)', () => {
  it('hints that an audio result matched the spoken words when the term is not in its caption', async () => {
    // The caption (a filename) does NOT contain the term, yet the audio item came
    // back from the catalog — so the match was in its transcript (search_meta FTS).
    // The hint explains why a "silent" tile surfaced for a text search.
    const api = makeFakeApi({
      searchCatalog: vi.fn(() =>
        Promise.resolve(
          makeSearchResult({
            items: [makeItemCard({ mediaType: 'audio', title: 'voice-051.m4a', description: null })],
          }),
        ),
      ),
    });
    const { user } = renderSearch(api);

    await user.type(screen.getByRole('searchbox'), 'familia');

    expect(await screen.findByText(/found in what was said/i)).toBeInTheDocument();
  });

  it('does NOT add the transcript hint when the term is already visible in the caption', async () => {
    const api = makeFakeApi({
      searchCatalog: vi.fn(() =>
        Promise.resolve(
          makeSearchResult({ items: [makeItemCard({ mediaType: 'audio', title: 'Familia reunion' })] }),
        ),
      ),
    });
    const { user } = renderSearch(api);

    await user.type(screen.getByRole('searchbox'), 'familia');

    expect(await screen.findByText(caption('Familia reunion'))).toBeInTheDocument();
    expect(screen.queryByText(/found in what was said/i)).not.toBeInTheDocument();
  });

  it('does NOT add the transcript hint to a photo (only audio/video are transcribed)', async () => {
    const api = makeFakeApi({
      searchCatalog: vi.fn(() =>
        Promise.resolve(
          makeSearchResult({ items: [makeItemCard({ mediaType: 'photo', title: 'beach-051.jpg' })] }),
        ),
      ),
    });
    const { user } = renderSearch(api);

    await user.type(screen.getByRole('searchbox'), 'familia');

    expect(await screen.findByText(caption('beach-051.jpg'))).toBeInTheDocument();
    expect(screen.queryByText(/found in what was said/i)).not.toBeInTheDocument();
  });

  it('shows a transcript-matched audio item exactly once (no duplicate tile)', async () => {
    const api = makeFakeApi({
      searchCatalog: vi.fn(() =>
        Promise.resolve(
          makeSearchResult({
            items: [makeItemCard({ id: 'once-1', mediaType: 'audio', title: 'voice-051.m4a' })],
          }),
        ),
      ),
    });
    const { user } = renderSearch(api);

    await user.type(screen.getByRole('searchbox'), 'familia');
    await screen.findByText(/found in what was said/i);

    expect(screen.getAllByRole('article')).toHaveLength(1);
  });
});

describe('Search — opening a result', () => {
  it('opens a result in its own view when its card is activated', async () => {
    const api = makeFakeApi({
      searchCatalog: vi.fn(() =>
        Promise.resolve(
          makeSearchResult({ items: [makeItemCard({ id: 'open-1', mediaType: 'audio', title: 'Open me' })] }),
        ),
      ),
    });
    const user = userEvent.setup();
    render(
      wrapInProviders(
        <>
          <Search />
          <ViewProbe />
        </>,
        api,
        { name: 'search' },
      ),
    );

    await user.type(screen.getByRole('searchbox'), 'open');
    await user.click(await screen.findByRole('button', { name: /open me/i }));

    expect(screen.getByTestId('active-view')).toHaveTextContent('item');
  });
});
