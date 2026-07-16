// Focused unit test for the result-area component extracted from Search.tsx
// (#436): the calm empty/loading/error faces, the result grid, and the
// server-side "show more" affordance (#431). Search.tsx's own integration tests
// already cover this wired end to end; this locks the standalone component's
// contract given each state directly, independent of that orchestration.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NavigationProvider } from '@renderer/lib/navigation';
import { SearchResults } from '@renderer/views/search/SearchResults';
import type { SearchResultsProps } from '@renderer/views/search/SearchResults';
import { makeItemCard } from './support/fake-api';

function defaultProps(over: Partial<SearchResultsProps> = {}): SearchResultsProps {
  return {
    phase: 'idle',
    hasQuery: true,
    loaded: true,
    hasResults: true,
    filtersActive: false,
    query: 'beach',
    items: [makeItemCard({ title: 'Beach picnic' })],
    total: 1,
    loadMoreFailed: false,
    onRetry: vi.fn(),
    onClearSearch: vi.fn(),
    onLoadMore: vi.fn(),
    ...over,
  };
}

function renderResults(props: SearchResultsProps) {
  return render(
    <NavigationProvider initialView={{ name: 'search' }}>
      <SearchResults {...props} />
    </NavigationProvider>,
  );
}

describe('SearchResults', () => {
  it('surfaces a gentle error with a retry, never the raw failure', async () => {
    const onRetry = vi.fn();
    renderResults(defaultProps({ phase: 'error', onRetry }));
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't search just now/i);
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the starting prompt before any query', () => {
    renderResults(defaultProps({ hasQuery: false, loaded: false, hasResults: false }));
    expect(screen.getByText(/start typing to search/i)).toBeInTheDocument();
  });

  it('shows a calm "looking" state while the first search is in flight', () => {
    renderResults(defaultProps({ loaded: false, hasResults: false }));
    expect(screen.getByText(/looking through the memories/i)).toBeInTheDocument();
  });

  it('names the term in a not-found state, with a way to clear the search', async () => {
    const onClearSearch = vi.fn();
    renderResults(
      defaultProps({ loaded: true, hasResults: false, items: [], total: 0, onClearSearch }),
    );
    expect(screen.getByText(/couldn't find anything for.*beach/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /clear search/i }));
    expect(onClearSearch).toHaveBeenCalledTimes(1);
  });

  it('points at the filters (not the words) for a filtered miss', () => {
    renderResults(
      defaultProps({ loaded: true, hasResults: false, items: [], total: 0, filtersActive: true }),
    );
    expect(screen.getByText(/no memories match these filters/i)).toBeInTheDocument();
  });

  it('renders each result with its caption, type label and highlighted term', () => {
    renderResults(
      defaultProps({
        items: [makeItemCard({ mediaType: 'photo', title: 'Beach picnic' })],
        query: 'beach',
      }),
    );
    expect(screen.getByRole('article')).toBeInTheDocument();
    expect(screen.getByText(/^photo$/i)).toBeInTheDocument();
    const mark = document.querySelector('mark');
    expect(mark).toHaveTextContent(/beach/i);
  });

  it('hints a transcript match only for audio/video whose caption lacks the term', () => {
    renderResults(
      defaultProps({
        items: [makeItemCard({ mediaType: 'audio', title: 'voice-051.m4a', description: null })],
        query: 'familia',
      }),
    );
    expect(screen.getByText(/found in what was said/i)).toBeInTheDocument();
  });

  it('shows "show more" with the true total once there is more beyond the page, and calls onLoadMore', async () => {
    const onLoadMore = vi.fn();
    renderResults(
      defaultProps({
        items: [makeItemCard({ title: 'First' })],
        total: 5,
        onLoadMore,
      }),
    );
    expect(screen.getByText(/showing 1 of 5 memories/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /show more/i }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('does not offer "show more" once the whole filtered set is on screen', () => {
    renderResults(defaultProps({ items: [makeItemCard({ title: 'Only one' })], total: 1 }));
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
  });

  it('surfaces a failed page inline without hiding the memories already loaded', () => {
    renderResults(
      defaultProps({
        items: [makeItemCard({ title: 'First' })],
        total: 5,
        loadMoreFailed: true,
      }),
    );
    expect(screen.getByText(/couldn't load more just now/i)).toBeInTheDocument();
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('falls back to the calm type label when a result has neither title nor description', () => {
    renderResults(
      defaultProps({
        items: [makeItemCard({ mediaType: 'document', title: null, description: null })],
        query: '',
      }),
    );
    expect(screen.getByText('Document memory')).toBeInTheDocument();
  });

  it('omits the date/source separators when a result carries neither', () => {
    renderResults(
      defaultProps({
        items: [makeItemCard({ title: 'Untethered', captureDate: null, source: null })],
        query: 'untethered',
      }),
    );
    const article = screen.getByRole('article');
    expect(article).not.toHaveTextContent('·');
  });

  it('shows a disabled "Gathering more…" button while a page is loading', () => {
    renderResults(
      defaultProps({
        items: [makeItemCard({ title: 'First' })],
        total: 5,
        phase: 'loadingMore',
      }),
    );
    expect(screen.getByRole('button', { name: /gathering more/i })).toBeDisabled();
  });
});
