import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MainApp } from '@renderer/app/MainApp';
import { useLibrary } from '@renderer/lib/library';
import type { TimelinePageDTO } from '@shared/kawsay-api';
import {
  makeFakeApi,
  makeItemCard,
  makeImportSummary,
  makeLibrarySummary,
  makeProgressEvent,
} from './support/fake-api';
import { wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';

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

// Leaving Timeline for an opened memory or Search used to UNMOUNT it — every
// piece of virtualization state (loaded pages, scroll offset) lived in local
// `useState`, so returning re-ran `useTimeline` from page 1 and reset scroll to
// the top. A person who opened a memory from deep in the timeline landed back
// at the very top on "Back" — disorienting (#432). MainApp now keeps Timeline
// mounted (hidden, out of the a11y tree) once visited instead of swapping it
// out, so its local state survives the round trip for free.
describe('MainApp — Timeline state survives navigating away and back (#432)', () => {
  function page(over: Partial<TimelinePageDTO> = {}): TimelinePageDTO {
    return { items: [], nextCursor: null, ...over };
  }

  /** Two pages, deterministic titles, same month (so row counts stay simple) —
   *  small enough that both auto-load without any scroll simulation, matching
   *  the existing streaming-pagination pattern in timeline.test.tsx. */
  function twoPageApi() {
    const page1Items = [0, 1, 2, 3].map((i) =>
      makeItemCard({ id: `p1-${i}`, title: `Page one memory ${i}`, captureDate: '2021-05-01T10:00:00.000Z' }),
    );
    const page2Items = [0, 1, 2, 3].map((i) =>
      makeItemCard({ id: `p2-${i}`, title: `Page two memory ${i}`, captureDate: '2021-04-01T10:00:00.000Z' }),
    );
    const getTimeline = vi
      .fn()
      .mockResolvedValueOnce(page({ items: page1Items, nextCursor: 'cursor-2' }))
      .mockResolvedValueOnce(page({ items: page2Items, nextCursor: null }));
    return { api: makeFakeApi({ getTimeline }), getTimeline, page1Items, page2Items };
  }

  it('Timeline → open item → Back: no page-1 refetch, both loaded pages kept, scroll restored', async () => {
    const { api, getTimeline } = twoPageApi();
    const user = userEvent.setup();
    render(wrapInProviders(<MainApp />, api, { name: 'timeline' }));

    // Both pages stream in automatically (small list, default viewport) — the
    // baseline this test proves survives a round trip untouched.
    await waitFor(() => expect(getTimeline).toHaveBeenCalledTimes(2));
    await screen.findByText('Page one memory 0');
    expect(screen.getByText('Page two memory 0')).toBeInTheDocument();

    const scrollRegion = screen.getByRole('region', { name: /memories/i });
    fireEvent.scroll(scrollRegion, { target: { scrollTop: 232 } });
    expect(scrollRegion.scrollTop).toBe(232);

    await user.click(screen.getByRole('button', { name: /open page one memory 0/i }));
    await screen.findByRole('heading', { level: 1, name: 'Page one memory 0' });

    await user.click(screen.getByRole('button', { name: /back/i }));

    const heading = await screen.findByRole('heading', { level: 1, name: /timeline/i });
    // Re-orients keyboard/screen-reader users the same way every fresh view
    // entry does (WCAG 2.4.3) — even though Timeline never remounted this time.
    await waitFor(() => expect(heading).toHaveFocus());

    // The crux of #432: no re-fetch of page 1.
    expect(getTimeline).toHaveBeenCalledTimes(2);
    // Both previously loaded pages are still on screen, not just page 1.
    expect(screen.getByText('Page one memory 0')).toBeInTheDocument();
    expect(screen.getByText('Page two memory 0')).toBeInTheDocument();
    // Scroll position survived the round trip.
    expect(screen.getByRole('region', { name: /memories/i }).scrollTop).toBe(232);
  });

  it('Timeline → Search → Timeline: no page-1 refetch, both loaded pages kept, scroll restored', async () => {
    const { api, getTimeline } = twoPageApi();
    const user = userEvent.setup();
    render(wrapInProviders(<MainApp />, api, { name: 'timeline' }));

    await waitFor(() => expect(getTimeline).toHaveBeenCalledTimes(2));
    const scrollRegion = screen.getByRole('region', { name: /memories/i });
    fireEvent.scroll(scrollRegion, { target: { scrollTop: 116 } });

    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Search' })).toBeInTheDocument();
    // While on Search, the hidden Timeline must not surface in the a11y tree.
    expect(screen.queryByRole('region', { name: /memories/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /^timeline$/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Timeline' }));
    const heading = await screen.findByRole('heading', { level: 1, name: /timeline/i });
    await waitFor(() => expect(heading).toHaveFocus());

    expect(getTimeline).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Page one memory 0')).toBeInTheDocument();
    expect(screen.getByText('Page two memory 0')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /memories/i }).scrollTop).toBe(116);
  });
});

describe('MainApp — the hidden Timeline stays out of the a11y tree while inactive (#432)', () => {
  it('excludes it from role queries and axe, and never traps focus, while an item is open', async () => {
    const items = [makeItemCard({ id: 'x1', title: 'Only memory' })];
    const api = makeFakeApi({ getTimeline: vi.fn(() => Promise.resolve({ items, nextCursor: null })) });
    const user = userEvent.setup();
    const { container } = render(wrapInProviders(<MainApp />, api, { name: 'timeline' }));

    await user.click(await screen.findByRole('button', { name: /open only memory/i }));
    await screen.findByRole('heading', { level: 1, name: 'Only memory' });

    // Exactly one level-1 heading exists — the item's, not the hidden Timeline's.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole('region', { name: /memories/i })).not.toBeInTheDocument();

    await expectNoAxeViolations(container);

    // Tab across the whole screen; focus must never land inside the hidden
    // Timeline subtree (no focus trap while it sits mounted-but-hidden).
    for (let i = 0; i < 15; i += 1) {
      await user.tab();
      const active = document.activeElement;
      expect(active === null || active.closest('[hidden]') !== null).toBeFalsy();
    }
  });

  it('excludes it from role queries and axe while Search is open', async () => {
    const items = [makeItemCard({ id: 'x1', title: 'Only memory' })];
    const api = makeFakeApi({ getTimeline: vi.fn(() => Promise.resolve({ items, nextCursor: null })) });
    const user = userEvent.setup();
    const { container } = render(wrapInProviders(<MainApp />, api, { name: 'timeline' }));

    await screen.findByText('Only memory');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('heading', { level: 1, name: 'Search' });

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole('region', { name: /memories/i })).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

// Keeping Timeline mounted (the #432 fix) removed the ONE thing that used to
// refresh its cached pages: a remount. Two data changes must therefore reach
// the mounted-but-cached timeline WITHOUT a remount, or "nothing is ever lost"
// silently breaks (#432 review regressions A + B).
describe('MainApp — cached timeline still reflects data changes without a remount (#432)', () => {
  function page(over: Partial<TimelinePageDTO> = {}): TimelinePageDTO {
    return { items: [], nextCursor: null, ...over };
  }

  // ── Regression A: a favourite marked on the item view must show on the card ──
  it('reflects a favourite marked in the item view on the timeline card when you go Back (no refetch)', async () => {
    const items = [makeItemCard({ id: 'fav-1', title: 'A tender moment', isFavourite: false })];
    const getTimeline = vi.fn(() => Promise.resolve(page({ items })));
    const api = makeFakeApi({ getTimeline });
    const user = userEvent.setup();
    render(wrapInProviders(<MainApp />, api, { name: 'timeline' }));

    // The card starts un-favourited — no heart glyph on it yet.
    const card = await screen.findByRole('article', { name: /a tender moment/i });
    expect(within(card).queryByRole('img', { name: /favourite/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /open a tender moment/i }));
    await screen.findByRole('heading', { level: 1, name: 'A tender moment' });

    // Mark it as a favourite — this persists via catalog:setFavourite and, on
    // settle, reconciles into the navigation-owned favourite override map.
    await user.click(screen.getByRole('button', { name: /mark as favourite/i }));
    await waitFor(() => expect(api.setFavourite).toHaveBeenCalledWith({ id: 'fav-1', favourite: true }));

    await user.click(screen.getByRole('button', { name: /back/i }));

    // Back on the (never-refetched) timeline, the card must now show the heart —
    // read from the override overlay, exactly as ItemView already does.
    const cardAfter = await screen.findByRole('article', { name: /a tender moment/i });
    await waitFor(() =>
      expect(within(cardAfter).getByRole('img', { name: /favourite/i })).toBeInTheDocument(),
    );
    // The whole round trip fetched page 1 exactly once — the override, not a
    // refetch, is what surfaced the change.
    expect(getTimeline).toHaveBeenCalledTimes(1);
  });

  // ── Regression B: a completed import must appear, not wait for a relaunch ──
  it('shows memories from a completed import when you return to the timeline (refetches page 1)', async () => {
    const oldItem = makeItemCard({ id: 'old-1', title: 'An older memory' });
    const newItem = makeItemCard({ id: 'new-1', title: 'A freshly imported memory' });
    const getTimeline = vi
      .fn()
      .mockResolvedValueOnce(page({ items: [oldItem], nextCursor: null }))
      .mockResolvedValueOnce(page({ items: [oldItem, newItem], nextCursor: null }));
    const api = makeFakeApi({ getTimeline });
    const user = userEvent.setup();
    render(
      wrapInProviders(
        <OpenLibraryThenRender>
          <MainApp />
        </OpenLibraryThenRender>,
        api,
        { name: 'timeline' },
      ),
    );

    await screen.findByText('An older memory');
    expect(getTimeline).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('A freshly imported memory')).not.toBeInTheDocument();

    // Walk the full Add Memories flow to a completed import.
    await user.click(screen.getByRole('button', { name: 'Add memories' }));
    await user.click(await screen.findByRole('button', { name: /whatsapp/i }));
    await screen.findByRole('heading', { level: 1, name: /whatsapp/i });
    for (let i = 0; i < 8; i += 1) {
      const next = screen.queryByRole('button', { name: /i've done this/i });
      if (!next) break;
      await user.click(next);
    }
    await user.type(screen.getByLabelText(/file|folder|where/i), '/exports/whatsapp.zip');
    await user.click(screen.getByRole('button', { name: /bring .*memories in/i }));
    api.emitProgress(makeProgressEvent({ phase: 'done', summary: makeImportSummary({ occurrencesAdded: 1 }) }));
    await screen.findByText(/1 memory is/i);

    // "See everything" returns to the timeline — which must now show the import.
    await user.click(screen.getByRole('button', { name: /see everything/i }));

    expect(await screen.findByText('A freshly imported memory')).toBeInTheDocument();
    // The completed import invalidated the cached timeline, so page 1 refetched.
    await waitFor(() => expect(getTimeline).toHaveBeenCalledTimes(2));
    // The older memory is still there too — nothing was lost.
    expect(screen.getByText('An older memory')).toBeInTheDocument();
  });

  // ── The AC invariant this must NOT break: pure navigation never refetches ──
  it('holds the sticky mount across a chained item + search round trip with no refetch (unchanged data)', async () => {
    const items = [0, 1].map((i) =>
      makeItemCard({ id: `c-${i}`, title: `Chained memory ${i}`, captureDate: '2021-05-01T10:00:00.000Z' }),
    );
    const getTimeline = vi.fn(() => Promise.resolve(page({ items, nextCursor: null })));
    const api = makeFakeApi({ getTimeline });
    const user = userEvent.setup();
    render(wrapInProviders(<MainApp />, api, { name: 'timeline' }));

    await screen.findByText('Chained memory 0');
    expect(getTimeline).toHaveBeenCalledTimes(1);

    // Timeline → item → Back
    await user.click(screen.getByRole('button', { name: /open chained memory 0/i }));
    await screen.findByRole('heading', { level: 1, name: 'Chained memory 0' });
    await user.click(screen.getByRole('button', { name: /back/i }));
    await screen.findByRole('heading', { level: 1, name: /timeline/i });

    // → Search → Timeline
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('heading', { level: 1, name: 'Search' });
    await user.click(screen.getByRole('button', { name: 'Timeline' }));
    await screen.findByRole('heading', { level: 1, name: /timeline/i });

    // The sticky mount held through every hop, and with data unchanged there was
    // never a bump — so page 1 was fetched exactly once across the whole chain.
    expect(screen.getByText('Chained memory 0')).toBeInTheDocument();
    expect(screen.getByText('Chained memory 1')).toBeInTheDocument();
    expect(getTimeline).toHaveBeenCalledTimes(1);
  });
});
