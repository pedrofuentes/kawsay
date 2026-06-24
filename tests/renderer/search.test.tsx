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
import { renderWithProviders, wrapInProviders } from './support/render';

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
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, delay: null });
      render(wrapInProviders(<Search />, api, { name: 'search' }));

      await user.type(screen.getByRole('searchbox'), 'mama');
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
    expect(screen.getByText(/photo/i)).toBeInTheDocument();
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
