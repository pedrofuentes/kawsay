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
    it('never renders banned phrases (your loved one, the deceased, the contact) when library name is absent', () => {
      // When a library exists but has no name (empty or undefined), the copy must
      // avoid all banned phrases that refer to the person. This test verifies the
      // add-memories description never renders "your loved one", "the deceased", or
      // "the contact" as fallback copy (P2 USER_FLOWS §1).
      const api = makeFakeApi();
      render(wrapInProviders(<MainApp />, api, { name: 'add-memories' }));

      // Check the rendered content for banned phrases.
      const container = screen.getByRole('heading', { level: 1, name: 'Add memories' }).parentElement;
      expect(container).not.toHaveTextContent(/your loved one/i);
      expect(container).not.toHaveTextContent(/the deceased/i);
      expect(container).not.toHaveTextContent(/the contact/i);
    });
  });
});
