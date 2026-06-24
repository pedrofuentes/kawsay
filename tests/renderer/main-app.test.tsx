import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MainApp } from '@renderer/app/MainApp';
import type { TimelinePageDTO } from '@shared/kawsay-api';
import { makeFakeApi, makeItemCard } from './support/fake-api';
import { wrapInProviders } from './support/render';

function page(over: Partial<TimelinePageDTO> = {}): TimelinePageDTO {
  return { items: [], nextCursor: null, ...over };
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

  it('leaves the search section placeholder untouched (owned by U2)', () => {
    const api = makeFakeApi();
    render(wrapInProviders(<MainApp />, api, { name: 'search' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Search' })).toBeInTheDocument();
    expect(screen.getByText(/search is on its way/i)).toBeInTheDocument();
  });
});
