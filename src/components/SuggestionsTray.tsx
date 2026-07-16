// The SUGGESTED-COLLECTIONS review tray (M4-3c / #273 / ADR-0030). A SEPARATE
// surface from the main collections list: it gently shows the place/theme groupings
// Kawsay noticed and lets the user curate each one — accept (optionally renamed
// first), merge into a collection they already have, or dismiss for good. It creates
// NOTHING on its own: a suggestion becomes a real collection ONLY when the user
// accepts or merges it here, so the main list never shows a suggested collection
// until then (AC-32).
//
// Visibility gate: the tray honours the SAME default-off gate as the explainable
// chips — it stays hidden until categorization is `offered` (the gazetteer asset is
// bundled) AND the user has `optedIn`, and also while there is simply nothing to
// review. So an opted-out (or caught-up) Settings view is byte-identical to before.
//
// Everything happens on this computer: there is no account and nothing is ever
// uploaded, exactly like every other Kawsay feature.
import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { SuggestionDTO, SuggestionMergeTargetDTO } from '@shared/kawsay-api';
import { cx } from '@renderer/lib/cx';
import { pluralize } from '@renderer/lib/pluralize';
import { Icon } from './Icon';
import { useCategorizationStatus } from '@renderer/lib/use-categorization';
import { useSuggestions } from '@renderer/lib/use-suggestions';

export function SuggestionsTray(): ReactElement | null {
  const { offered, optedIn, loading: statusLoading } = useCategorizationStatus();
  const enabled = offered && optedIn;
  const { suggestions, collections, loading, actionError, accept, merge, dismiss } =
    useSuggestions(enabled);
  const headingId = useId();

  // Stay hidden while the gate is resolving, while the feature is off, while the
  // first read is in flight, and whenever there is nothing to review — so Settings
  // is unchanged until there is genuinely a suggestion to show (AC-32).
  if (statusLoading || !enabled || loading || suggestions.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-6 rounded-2xl border border-border-subtle bg-surface-raised p-6"
    >
      <div className="flex items-start gap-4">
        <span
          aria-hidden
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-sage-50 text-sage-600"
        >
          <Icon name="sparkle" className="h-6 w-6" />
        </span>
        <div className="flex flex-col gap-1">
          <h2
            id={headingId}
            className="font-display text-2xl font-semibold leading-tight text-text-primary"
          >
            Suggested collections
          </h2>
          <p className="font-body text-base text-text-secondary">
            Kawsay noticed these groupings while organizing. Nothing is added to your collections
            until you accept it — and it all stays on this computer.
          </p>
        </div>
      </div>

      {actionError && (
        <p
          role="status"
          className="rounded-xl border border-error-border bg-error-bg px-4 py-3 font-body text-sm text-error-text"
        >
          Sorry, we couldn&apos;t confirm that change just now — please refresh or try again.
        </p>
      )}

      <ul className="flex flex-col gap-4">
        {suggestions.map((suggestion) => (
          <SuggestionCard
            key={suggestion.categoryId}
            suggestion={suggestion}
            collections={collections}
            onAccept={accept}
            onMerge={merge}
            onDismiss={dismiss}
          />
        ))}
      </ul>
    </section>
  );
}

interface SuggestionCardProps {
  suggestion: SuggestionDTO;
  collections: SuggestionMergeTargetDTO[];
  onAccept(input: { categoryId: string; name?: string }): void;
  onMerge(input: { categoryId: string; intoCollectionId: string }): void;
  onDismiss(input: { categoryId: string }): void;
}

function SuggestionCard({
  suggestion,
  collections,
  onAccept,
  onMerge,
  onDismiss,
}: SuggestionCardProps): ReactElement {
  const nameId = useId();
  const mergeId = useId();
  const examplesId = useId();
  const [name, setName] = useState(suggestion.name);
  const [mergeTarget, setMergeTarget] = useState('');

  const trimmedName = name.trim();
  const kindLabel = suggestion.kind === 'place' ? 'Place' : 'Theme';
  const memberLabel = `${suggestion.memberCount} ${pluralize(suggestion.memberCount, 'memory', 'memories')}`;

  return (
    <li className="flex flex-col gap-4 rounded-xl bg-surface-sunken p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-sage-50 px-3 py-1 font-body text-sm font-medium text-sage-600">
          {kindLabel}
        </span>
        <span className="font-body text-sm text-text-secondary">{memberLabel}</span>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="font-body text-sm font-medium text-text-primary">
          Suggested name
        </label>
        <input
          id={nameId}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="rounded-lg border border-border-interactive bg-surface-raised px-3 py-2 font-body text-base text-text-primary"
        />
      </div>

      {suggestion.examples.length > 0 && (
        <div className="flex flex-col gap-2">
          <p id={examplesId} className="font-body text-sm text-text-secondary">
            For example
          </p>
          <div aria-labelledby={examplesId} role="group" className="flex flex-wrap gap-2">
            {suggestion.examples.map((example) => (
              <span
                key={example.id}
                className="rounded-lg bg-surface-raised px-3 py-1 font-body text-sm text-text-primary"
              >
                {example.title ?? 'Untitled memory'}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <button
          type="button"
          onClick={() => onAccept({ categoryId: suggestion.categoryId, name: trimmedName })}
          disabled={trimmedName.length === 0}
          className={cx(
            'rounded-lg px-4 py-2 font-body text-base font-medium text-white transition-colors duration-150',
            trimmedName.length === 0 ? 'bg-border-interactive' : 'bg-sage-600',
          )}
        >
          Accept
        </button>

        {collections.length > 0 && (
          <div className="flex flex-col gap-1">
            <label htmlFor={mergeId} className="font-body text-sm text-text-secondary">
              Merge into
            </label>
            <div className="flex items-center gap-2">
              <select
                id={mergeId}
                value={mergeTarget}
                onChange={(event) => setMergeTarget(event.target.value)}
                className="rounded-lg border border-border-interactive bg-surface-raised px-3 py-2 font-body text-base text-text-primary"
              >
                <option value="">Choose a collection…</option>
                {collections.map((collection) => (
                  <option key={collection.collectionId} value={collection.collectionId}>
                    {collection.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() =>
                  onMerge({ categoryId: suggestion.categoryId, intoCollectionId: mergeTarget })
                }
                disabled={mergeTarget === ''}
                className={cx(
                  'rounded-lg border px-4 py-2 font-body text-base font-medium transition-colors duration-150',
                  mergeTarget === ''
                    ? 'border-border-subtle text-text-secondary'
                    : 'border-border-interactive text-text-primary',
                )}
              >
                Merge
              </button>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => onDismiss({ categoryId: suggestion.categoryId })}
          className="rounded-lg px-4 py-2 font-body text-base text-text-secondary underline decoration-border-interactive underline-offset-4"
        >
          Dismiss
        </button>
      </div>
    </li>
  );
}
