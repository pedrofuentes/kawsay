// Focused unit test for the presentational filter bar extracted from Search.tsx
// (#436). Search.tsx's own integration tests already cover the wired behaviour
// (debounce, server-side filtering); this locks the standalone component's
// contract with its own props, independent of that orchestration.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MediaType, SourceType } from '@shared/kawsay-api';
import { SearchFilterBar } from '@renderer/views/search/SearchFilterBar';
import type { SearchFilterBarProps } from '@renderer/views/search/SearchFilterBar';

function defaultProps(over: Partial<SearchFilterBarProps> = {}): SearchFilterBarProps {
  return {
    inputId: 'search-input',
    hintId: 'search-hint',
    label: 'Search the memories',
    rawQuery: '',
    onQueryChange: vi.fn(),
    activeTypes: new Set<MediaType>(),
    onToggleType: vi.fn(),
    activeSource: null,
    onSourceChange: vi.fn(),
    fromDate: '',
    onFromDateChange: vi.fn(),
    toDate: '',
    onToDateChange: vi.fn(),
    filtersActive: false,
    onClearFilters: vi.fn(),
    statusText: '',
    ...over,
  };
}

describe('SearchFilterBar', () => {
  it('renders a labelled search box inside a search landmark', () => {
    render(<SearchFilterBar {...defaultProps()} />);
    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: /search the memories/i })).toBeInTheDocument();
  });

  it('reports every keystroke through onQueryChange', async () => {
    const onQueryChange = vi.fn();
    render(<SearchFilterBar {...defaultProps({ onQueryChange })} />);
    await userEvent.type(screen.getByRole('searchbox'), 'a');
    expect(onQueryChange).toHaveBeenCalledWith('a');
  });

  it('groups the type filters and toggles a chip through onToggleType', async () => {
    const onToggleType = vi.fn();
    render(<SearchFilterBar {...defaultProps({ onToggleType })} />);
    expect(screen.getByRole('group', { name: /filter by type/i })).toBeInTheDocument();
    const videos = screen.getByRole('button', { name: /videos/i });
    expect(videos).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(videos);
    expect(onToggleType).toHaveBeenCalledWith('video');
  });

  it('reflects an already-active type as pressed', () => {
    render(<SearchFilterBar {...defaultProps({ activeTypes: new Set<MediaType>(['photo']) })} />);
    expect(screen.getByRole('button', { name: /^photos$/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('reports a chosen source through onSourceChange', async () => {
    const onSourceChange = vi.fn();
    render(<SearchFilterBar {...defaultProps({ onSourceChange })} />);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /source/i }),
      'whatsapp' satisfies SourceType,
    );
    expect(onSourceChange).toHaveBeenCalledWith('whatsapp');
  });

  it('only shows "Clear filters" once a filter is active', () => {
    const { rerender } = render(<SearchFilterBar {...defaultProps({ filtersActive: false })} />);
    expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument();
    rerender(<SearchFilterBar {...defaultProps({ filtersActive: true })} />);
    expect(screen.getByRole('button', { name: /clear filters/i })).toBeInTheDocument();
  });

  it('renders the given status text in a polite live region', () => {
    render(<SearchFilterBar {...defaultProps({ statusText: '3 memories found' })} />);
    expect(screen.getByRole('status')).toHaveTextContent('3 memories found');
  });

  it('constrains each date field by the other once both are set', () => {
    render(<SearchFilterBar {...defaultProps({ fromDate: '2020-01-01', toDate: '2020-06-01' })} />);
    expect(screen.getByLabelText(/^from$/i)).toHaveAttribute('max', '2020-06-01');
    expect(screen.getByLabelText(/^to$/i)).toHaveAttribute('min', '2020-01-01');
  });

  it('reports date edits through onFromDateChange and onToDateChange', async () => {
    const onFromDateChange = vi.fn();
    const onToDateChange = vi.fn();
    render(<SearchFilterBar {...defaultProps({ onFromDateChange, onToDateChange })} />);
    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: '2020-01-01' } });
    fireEvent.change(screen.getByLabelText(/^to$/i), { target: { value: '2020-06-01' } });
    expect(onFromDateChange).toHaveBeenCalledWith('2020-01-01');
    expect(onToDateChange).toHaveBeenCalledWith('2020-06-01');
  });
});
