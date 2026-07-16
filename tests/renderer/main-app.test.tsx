import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  describe('add-memories view banned-phrase compliance (P2, #435 · #427)', () => {
    // #427 replaced the placeholder InfoView with the real guided Add Memories flow;
    // the P2 banned-phrase invariant from #435 carries over onto the live view — no
    // "your loved one" / "the deceased" / "the contact", and never a broken
    // "undefined" interpolation, in any state.
    it('never renders banned phrases (your loved one, the deceased, the contact) when no library is open', () => {
      const api = makeFakeApi();
      render(wrapInProviders(<MainApp />, api, { name: 'add-memories' }));

      // The live view lands on its source chooser, titled "Add memories".
      expect(screen.getByRole('heading', { level: 1, name: 'Add memories' })).toBeInTheDocument();
      const main = screen.getByRole('main');
      expect(main).not.toHaveTextContent(/your loved one/i);
      expect(main).not.toHaveTextContent(/the deceased/i);
      expect(main).not.toHaveTextContent(/the contact/i);
      // A broken name interpolation must never leak, even with no library open.
      expect(main).not.toHaveTextContent(/undefined/i);
    });

    it('personalizes the guided copy with the library name when a library is open', async () => {
      const user = userEvent.setup();
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

      // Picking a source enters the guided walkthrough, which interpolates the
      // person's name into its copy (openLibrary resolves asynchronously, so this
      // polls until the named copy lands). Pinning the exact possessive phrase makes
      // the check discriminating: a broken `personName` (empty/fallback/undefined)
      // or a reintroduced banned phrase would fail it, not silently pass.
      await user.click(await screen.findByRole('button', { name: /whatsapp/i }));
      await screen.findByText(/Grandma Rosa's WhatsApp/);
      const main = screen.getByRole('main');
      expect(main).toHaveTextContent("Grandma Rosa's WhatsApp");
      expect(main).not.toHaveTextContent(/your loved one/i);
      expect(main).not.toHaveTextContent(/the deceased/i);
      expect(main).not.toHaveTextContent(/undefined/i);
    });
  });
});
