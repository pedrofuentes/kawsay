// Extracted from Search.tsx (#436) — the search box, the type/source/date
// filters, and the live status region. Purely presentational: every value and
// every change handler is owned by Search (the orchestrating container), which
// keeps the debounce, the server-side filtering, and the race-guarding intact.
import type { ChangeEvent, ReactElement } from 'react';
import type { MediaType, SourceType } from '@shared/kawsay-api';
import { Button } from '@renderer/components/Button';
import { Icon } from '@renderer/components/Icon';
import { MEDIA_META, MEDIA_TYPE_ORDER } from '@renderer/lib/media-meta';
import { SOURCES } from '@renderer/onboarding/sources';
import { cx } from '@renderer/lib/cx';

export interface SearchFilterBarProps {
  inputId: string;
  hintId: string;
  label: string;
  rawQuery: string;
  onQueryChange: (value: string) => void;
  activeTypes: ReadonlySet<MediaType>;
  onToggleType: (type: MediaType) => void;
  activeSource: SourceType | null;
  onSourceChange: (source: SourceType | null) => void;
  fromDate: string;
  onFromDateChange: (value: string) => void;
  toDate: string;
  onToDateChange: (value: string) => void;
  filtersActive: boolean;
  onClearFilters: () => void;
  statusText: string;
}

export function SearchFilterBar({
  inputId,
  hintId,
  label,
  rawQuery,
  onQueryChange,
  activeTypes,
  onToggleType,
  activeSource,
  onSourceChange,
  fromDate,
  onFromDateChange,
  toDate,
  onToDateChange,
  filtersActive,
  onClearFilters,
  statusText,
}: SearchFilterBarProps): ReactElement {
  return (
    <form
      role="search"
      className="flex flex-col gap-5"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="flex flex-col gap-2">
        <label htmlFor={inputId} className="font-body text-base font-medium text-text-primary">
          {label}
        </label>
        <input
          id={inputId}
          type="search"
          value={rawQuery}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onQueryChange(event.target.value)}
          aria-describedby={hintId}
          autoComplete="off"
          placeholder="A name, a place, a few words…"
          className="min-h-14 rounded-lg border border-border-interactive bg-surface-raised px-4 font-body text-md text-text-primary placeholder:text-text-secondary"
        />
        <p id={hintId} className="font-body text-sm text-text-secondary">
          Memories never leave this computer.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div role="group" aria-label="Filter by type" className="flex flex-wrap gap-2">
          {MEDIA_TYPE_ORDER.map((type) => {
            const pressed = activeTypes.has(type);
            return (
              <button
                key={type}
                type="button"
                aria-pressed={pressed}
                onClick={() => onToggleType(type)}
                className={cx(
                  'inline-flex min-h-11 items-center gap-2 rounded-full border px-4 font-body text-base transition-colors duration-150',
                  pressed
                    ? 'border-sage-600 bg-sage-600 text-text-on-primary'
                    : 'border-border-default bg-surface-raised text-text-secondary hover:bg-surface-tinted',
                )}
              >
                <Icon name={MEDIA_META[type].icon} className="h-4 w-4" />
                {MEDIA_META[type].chipLabel}
              </button>
            );
          })}
        </div>

        <div role="group" aria-label="Filter by source" className="flex flex-col gap-1">
          <label htmlFor={`${inputId}-source`} className="font-body text-sm text-text-secondary">
            Source
          </label>
          <select
            id={`${inputId}-source`}
            value={activeSource ?? ''}
            onChange={(event) =>
              onSourceChange(event.target.value === '' ? null : (event.target.value as SourceType))
            }
            className="min-h-11 w-full max-w-xs rounded-lg border border-border-default bg-surface-raised px-3 font-body text-base text-text-primary"
          >
            <option value="">All sources</option>
            {SOURCES.map((source) => (
              <option key={source.type} value={source.type}>
                {source.title}
              </option>
            ))}
          </select>
        </div>

        <div role="group" aria-label="Filter by date" className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${inputId}-from`} className="font-body text-sm text-text-secondary">
              From
            </label>
            <input
              id={`${inputId}-from`}
              type="date"
              value={fromDate}
              max={toDate === '' ? undefined : toDate}
              onChange={(event) => onFromDateChange(event.target.value)}
              className="min-h-11 rounded-lg border border-border-default bg-surface-raised px-3 font-body text-base text-text-primary"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${inputId}-to`} className="font-body text-sm text-text-secondary">
              To
            </label>
            <input
              id={`${inputId}-to`}
              type="date"
              value={toDate}
              min={fromDate === '' ? undefined : fromDate}
              onChange={(event) => onToDateChange(event.target.value)}
              className="min-h-11 rounded-lg border border-border-default bg-surface-raised px-3 font-body text-base text-text-primary"
            />
          </div>
          {filtersActive ? (
            <Button variant="ghost" onClick={onClearFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>
      </div>

      <p role="status" aria-live="polite" className="min-h-5 font-body text-sm text-text-secondary">
        {statusText}
      </p>
    </form>
  );
}
