import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { LibraryProvider } from '@renderer/lib/library';
import { NavigationProvider } from '@renderer/lib/navigation';
import { Timeline } from '@renderer/views/Timeline';
import type { ItemCardDTO, TimelinePageDTO } from '@shared/kawsay-api';
import { makeFakeApi, makeItemCard } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { ViewProbe, wrapInProviders } from './support/render';

function page(over: Partial<TimelinePageDTO> = {}): TimelinePageDTO {
  return { items: [], nextCursor: null, ...over };
}

/** Deterministic, newest-first items one day apart, so a 1k and a 10k library
 *  share an identical prefix — letting us assert the rendered window is the same
 *  size regardless of total item count (AC-8). */
function seededItems(count: number): ItemCardDTO[] {
  const base = Date.UTC(2024, 0, 1, 12, 0, 0);
  const dayMs = 86_400_000;
  return Array.from({ length: count }, (_, i) =>
    makeItemCard({
      id: `seed-item-${i}`,
      title: `Memory number ${i}`,
      captureDate: new Date(base - i * dayMs).toISOString(),
      mediaType: 'photo',
    }),
  );
}

function renderTimeline(api: FakeApi) {
  return render(wrapInProviders(<Timeline />, api));
}

describe('Timeline — loading state (calm, never a bare spinner)', () => {
  it('shows reassuring activity while the first page is in flight', async () => {
    let resolve: (value: TimelinePageDTO) => void = () => undefined;
    const pending = new Promise<TimelinePageDTO>((r) => {
      resolve = r;
    });
    const api = makeFakeApi({ getTimeline: vi.fn(() => pending) });
    renderTimeline(api);

    const busy = await screen.findByRole('status');
    expect(busy).toHaveTextContent(/gathering|bringing|moment/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => {
      resolve(page({ items: [], nextCursor: null }));
    });
  });
});

describe('Timeline — empty state (warm, never blaming)', () => {
  it('invites a first import and routes to Add memories', async () => {
    const api = makeFakeApi({ getTimeline: vi.fn(() => Promise.resolve(page())) });
    render(
      wrapInProviders(
        <>
          <Timeline />
          <ViewProbe />
        </>,
        api,
      ),
    );

    const heading = await screen.findByRole('heading', { name: /gather here|ready/i });
    expect(heading).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: /add memories/i });
    await userEvent.click(cta);
    expect(screen.getByTestId('active-view')).toHaveTextContent('add-memories');
  });
});

describe('Timeline — error state (plain language + retry)', () => {
  it('shows an ErrorBanner with no raw code and recovers on retry', async () => {
    const getTimeline = vi
      .fn()
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
      .mockResolvedValueOnce(page({ items: [makeItemCard({ title: 'Recovered memory' })] }));
    const api = makeFakeApi({ getTimeline });
    renderTimeline(api);

    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent(/SQLITE_BUSY/);
    await userEvent.click(within(alert).getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Recovered memory')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Timeline — grouped, reverse-chronological (AC-6)', () => {
  it('groups memories under month/year headers, newest first', async () => {
    const items: ItemCardDTO[] = [
      makeItemCard({ id: 'a', title: 'Birthday dinner', captureDate: '2021-03-14T18:00:00.000Z' }),
      makeItemCard({ id: 'b', title: 'Park walk', captureDate: '2021-03-02T09:00:00.000Z' }),
      makeItemCard({ id: 'c', title: 'New year call', captureDate: '2021-01-01T00:30:00.000Z' }),
    ];
    const api = makeFakeApi({ getTimeline: vi.fn(() => Promise.resolve(page({ items }))) });
    renderTimeline(api);

    await screen.findByText('Birthday dinner');
    const headers = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    const march = headers.findIndex((t) => /March 2021/i.test(t ?? ''));
    const january = headers.findIndex((t) => /January 2021/i.test(t ?? ''));
    expect(march).toBeGreaterThanOrEqual(0);
    expect(january).toBeGreaterThan(march); // newest month appears first
    expect(screen.getByText('Park walk')).toBeInTheDocument();
    expect(screen.getByText('New year call')).toBeInTheDocument();
  });

  it('renders each memory as a labelled article carrying its type and date', async () => {
    const items = [
      makeItemCard({ id: 'v', title: 'Last summer', mediaType: 'video', captureDate: '2020-07-04T12:00:00.000Z' }),
    ];
    const api = makeFakeApi({ getTimeline: vi.fn(() => Promise.resolve(page({ items }))) });
    renderTimeline(api);

    const article = await screen.findByRole('article');
    expect(article).toHaveAccessibleName(/video/i);
    expect(article).toHaveTextContent('Last summer');
    expect(article).toHaveTextContent(/2020/);
  });

  it('handles undated memories gracefully instead of crashing', async () => {
    const items = [makeItemCard({ id: 'u', title: 'Unknown date', captureDate: null })];
    const api = makeFakeApi({ getTimeline: vi.fn(() => Promise.resolve(page({ items }))) });
    renderTimeline(api);

    expect(await screen.findByText('Unknown date')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /date unknown/i })).toBeInTheDocument();
  });
});

describe('Timeline — virtualization at scale (AC-8)', () => {
  it('mounts only a bounded window of memories, identical at 1,000 and 10,000 items', async () => {
    const renderAt = async (count: number): Promise<number> => {
      const api = makeFakeApi({
        getTimeline: vi.fn(() => Promise.resolve(page({ items: seededItems(count), nextCursor: null }))),
      });
      const view = renderTimeline(api);
      await screen.findAllByRole('article');
      const mounted = view.container.querySelectorAll('article').length;
      view.unmount();
      return mounted;
    };

    const small = await renderAt(1_000);
    const large = await renderAt(10_000);

    expect(large).toBe(small);
    expect(large).toBeLessThan(60); // a fixed cap, never the full 10,000
    expect(large).toBeGreaterThan(0);
  });

  it('streams further pages through the cursor as the window reaches the end', async () => {
    const getTimeline = vi
      .fn()
      .mockResolvedValueOnce(page({ items: seededItems(4), nextCursor: 'cursor-2' }))
      .mockResolvedValueOnce(
        page({
          items: seededItems(8).slice(4).map((it, i) => ({ ...it, id: `more-${i}`, title: `More ${i}` })),
          nextCursor: null,
        }),
      );
    const api = makeFakeApi({ getTimeline });
    renderTimeline(api);

    await waitFor(() => expect(getTimeline).toHaveBeenCalledTimes(2));
    expect(getTimeline.mock.calls[1]?.[0]).toMatchObject({ cursor: 'cursor-2' });
  });
});

describe('Timeline — mid-scroll pagination failure stays non-silent and recoverable (#101)', () => {
  it('surfaces a gentle retry affordance when a later page fails, keeping loaded memories', async () => {
    const getTimeline = vi
      .fn()
      .mockResolvedValueOnce(page({ items: seededItems(4), nextCursor: 'cursor-2' }))
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    const api = makeFakeApi({ getTimeline });
    renderTimeline(api);

    // The first page renders, then the auto-streamed next page rejects.
    expect(await screen.findByText('Memory number 0')).toBeInTheDocument();
    await waitFor(() => expect(getTimeline).toHaveBeenCalledTimes(2));

    // The failure is announced calmly (plain language, never a raw code) with a
    // way to recover — not a silent dead-stop.
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent(/SQLITE_BUSY/);
    expect(within(alert).getByRole('button', { name: /try again/i })).toBeInTheDocument();

    // Already-loaded memories are never lost.
    expect(screen.getByText('Memory number 0')).toBeInTheDocument();
  });

  it('retries the failed page on demand, clears the error, and appends the recovered memories', async () => {
    const recovered = makeItemCard({
      id: 'recovered',
      title: 'Recovered later memory',
      captureDate: '2020-01-01T12:00:00.000Z',
    });
    const getTimeline = vi
      .fn()
      .mockResolvedValueOnce(page({ items: seededItems(4), nextCursor: 'cursor-2' }))
      .mockRejectedValueOnce(new Error('temporary glitch'))
      .mockResolvedValueOnce(page({ items: [recovered], nextCursor: null }));
    const api = makeFakeApi({ getTimeline });
    renderTimeline(api);

    const alert = await screen.findByRole('alert');
    await userEvent.click(within(alert).getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Recovered later memory')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The earlier page is still present, and the retry re-requested the same cursor.
    expect(screen.getByText('Memory number 0')).toBeInTheDocument();
    expect(getTimeline.mock.calls[2]?.[0]).toMatchObject({ cursor: 'cursor-2' });
  });
});

describe('Timeline — untrusted catalog data is rendered as escaped text (security)', () => {
  it('never interprets markup smuggled into a caption or filename', async () => {
    const malicious = '<script>window.__xss__=1</script><img src=x onerror="window.__xss__=1">';
    const items = [makeItemCard({ id: 'x', title: malicious, description: malicious })];
    const api = makeFakeApi({ getTimeline: vi.fn(() => Promise.resolve(page({ items }))) });
    const { container } = renderTimeline(api);

    await screen.findByRole('article');
    // The payload is shown verbatim as text, not parsed into live nodes.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __xss__?: number }).__xss__).toBeUndefined();
    expect(container.textContent).toContain('<script>');
  });
});

describe('Timeline — accessibility (WCAG 2.1 AA essentials, AC-13)', () => {
  it('exposes a named region, a focusable page heading, headings, and named articles; no autoplay media', async () => {
    const items = [
      makeItemCard({ id: 'p1', title: 'Sunrise', mediaType: 'photo', captureDate: '2022-05-10T06:00:00.000Z' }),
      makeItemCard({ id: 'p2', title: 'Voice note', mediaType: 'audio', captureDate: '2022-05-09T06:00:00.000Z' }),
    ];
    const api = makeFakeApi({ getTimeline: vi.fn(() => Promise.resolve(page({ items }))) });
    const { container } = renderTimeline(api);

    await screen.findByText('Sunrise');
    expect(screen.getByRole('region', { name: /memories/i })).toBeInTheDocument();
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveAttribute('tabindex', '-1');
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('article').length).toBeGreaterThan(0);
    // No media element is ever mounted, so nothing can auto-play (R11).
    expect(container.querySelector('video, audio')).toBeNull();
  });
});

describe('Timeline — tolerates a missing bridge (browser preview)', () => {
  it('shows a calm not-connected message instead of crashing', () => {
    const original = (window as { kawsayAPI?: unknown }).kawsayAPI;
    delete (window as { kawsayAPI?: unknown }).kawsayAPI;
    try {
      render(
        <KawsayApiProvider>
          <LibraryProvider>
            <NavigationProvider initialView={{ name: 'timeline' }}>
              <Timeline />
            </NavigationProvider>
          </LibraryProvider>
        </KawsayApiProvider>,
      );
      expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    } finally {
      if (original !== undefined) (window as { kawsayAPI?: unknown }).kawsayAPI = original;
    }
  });
});
