import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MainApp } from '@renderer/app/MainApp';
import { useLibrary } from '@renderer/lib/library';
import type { TimelinePageDTO } from '@shared/kawsay-api';
import { makeFakeApi, makeItemCard, makeLibrarySummary } from './support/fake-api';
import { wrapInProviders } from './support/render';

function page(over: Partial<TimelinePageDTO> = {}): TimelinePageDTO {
  return { items: [], nextCursor: null, ...over };
}

// LibraryProvider starts with no open library and only populates one once
// `openLibrary`/`createLibrary` resolves (see src/lib/library.tsx) — there is no
// eager load from the API. To exercise MainApp's named-library branch, this helper
// triggers `openLibrary` on mount (inside the same provider tree as the child it
// wraps) so the fake API's resolved, named summary lands in context before the
// test asserts on it.
function OpenLibraryThenRender({ children }: { children: ReactElement }): ReactElement {
  const { openLibrary } = useLibrary();
  useEffect(() => {
    void openLibrary({ path: '/lib/rosa' });
  }, [openLibrary]);
  return children;
}

describe('MainApp routing', () => {
  it('mounts the real Timeline (not a placeholder) for the timeline view', async () => {
    const items = [makeItemCard({ id: 'm1', title: 'A walk by the sea' })];
    const api = makeFakeApi({ getTimeline: vi.fn(() => Promise.resolve(page({ items }))) });
    render(wrapInProviders(<MainApp />, api, { name: 'timeline' }));

    // The placeholder never rendered article/region semantics — the live Timeline does.
    expect(await screen.findByRole('article')).toHaveTextContent('A walk by the sea');
    expect(screen.getByRole('region', { name: /memories/i })).toBeInTheDocument();
  });

  it('mounts the real Search view (not a placeholder) for the search view', () => {
    const api = makeFakeApi();
    render(wrapInProviders(<MainApp />, api, { name: 'search' }));
    // The placeholder never rendered a search landmark or box — the live Search view does.
    expect(screen.getByRole('heading', { level: 1, name: 'Search' })).toBeInTheDocument();
    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeInTheDocument();
    expect(screen.queryByText(/search is on its way/i)).not.toBeInTheDocument();
  });

  describe('add-memories view banned-phrase compliance (P2, #435)', () => {
    it('never renders banned phrases (your loved one, the deceased, the contact) when no library is open', () => {
      // When no library is open (library === null), the copy must avoid all banned
      // phrases that refer to the person. This test verifies the add-memories
      // description never renders "your loved one", "the deceased", or "the contact"
      // as fallback copy (P2 USER_FLOWS §1), and pins the exact neutral copy so a
      // regression like an interpolated "undefined's library" would also fail it.
      const api = makeFakeApi();
      render(wrapInProviders(<MainApp />, api, { name: 'add-memories' }));

      // Check the rendered content for banned phrases.
      const container = screen.getByRole('heading', { level: 1, name: 'Add memories' }).parentElement;
      expect(container).not.toHaveTextContent(/your loved one/i);
      expect(container).not.toHaveTextContent(/the deceased/i);
      expect(container).not.toHaveTextContent(/the contact/i);
      // Positive oracle: pin the exact neutral copy, not just the absence of banned
      // phrases — a broken fallback like "Add another source to undefined's library"
      // would still pass the negative checks above but must fail this one.
      expect(container).toHaveTextContent(
        "Add another source to this library whenever you're ready.",
      );
    });

    it('personalizes the add-memories copy with the library name when a library is open', async () => {
      const api = makeFakeApi({
        openLibrary: vi.fn(() =>
          Promise.resolve(makeLibrarySummary({ name: 'Grandma Rosa', root: '/lib/rosa' })),
        ),
      });
      render(
        wrapInProviders(
          <OpenLibraryThenRender>
            <MainApp />
          </OpenLibraryThenRender>,
          api,
          { name: 'add-memories' },
        ),
      );

      // openLibrary resolves asynchronously (LibraryProvider awaits the fake API
      // call before storing the summary), so wait for the personalized copy.
      expect(await screen.findByText(/Grandma Rosa's library/)).toBeInTheDocument();
    });
  });
});
