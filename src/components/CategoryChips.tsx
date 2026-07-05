// The per-item CATEGORY CHIPS + correction UI (#270 / ADR-0030). It shows the
// place/theme groupings ONE memory belongs to, each as a calm chip that explains
// itself — the source (Auto vs a decision you made), the human reason, and, for an
// automatic guess, how sure it is. From here a user can gently correct the machine:
// confirm a good guess, rename a group, move the memory to another group, or remove
// it entirely. Each correction is written as a decision that a later re-cluster can
// never overwrite (provenance durability, AC-30).
//
// DEFAULT-OFF (AC-33): while the user has not opted in this renders NOTHING and never
// even asks for the item's chips — browse/search/timeline stay byte-identical to a
// catalog that never heard of categorization.
import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { ItemCardDTO, ItemCategoryDTO } from '@shared/kawsay-api';
import { cx } from '@renderer/lib/cx';
import { useCategorizationStatus, useItemCategories } from '@renderer/lib/use-categorization';

/** The explainable one-line tooltip: "Auto · Near Cusco, Perú (from photo GPS) · 0.92". */
function reasonText(category: ItemCategoryDTO): string {
  const parts: string[] = [category.source === 'user' ? 'By you' : 'Auto'];
  if (category.explanation !== null && category.explanation.length > 0) {
    parts.push(category.explanation);
  }
  // A certain human decision (confidence null) invents no numeric score.
  if (category.confidence !== null) {
    parts.push(category.confidence.toFixed(2));
  }
  return parts.join(' · ');
}

const ACTION_BUTTON_CLASS =
  'inline-flex min-h-9 items-center rounded-lg border border-border-interactive bg-surface-raised px-3 font-body text-sm font-medium text-text-primary transition-colors duration-150 hover:bg-surface-tinted';

type Editing = { categoryId: string; mode: 'rename' | 'reassign' } | null;

export function CategoryChips({ item }: { item: ItemCardDTO }): ReactElement | null {
  const { optedIn } = useCategorizationStatus();
  const { categories, applyCorrection } = useItemCategories(item.id, optedIn);

  const baseId = useId();
  const [editing, setEditing] = useState<Editing>(null);
  const [draftName, setDraftName] = useState('');

  // DEFAULT-OFF and calm empty state: no surface at all until there is something to show.
  if (!optedIn || categories.length === 0) {
    return null;
  }

  function startRename(category: ItemCategoryDTO): void {
    setDraftName(category.name);
    setEditing({ categoryId: category.categoryId, mode: 'rename' });
  }

  function commitRename(category: ItemCategoryDTO): void {
    const name = draftName.trim();
    if (name.length > 0) {
      applyCorrection({ kind: 'rename', itemId: item.id, categoryId: category.categoryId, name });
    }
    setEditing(null);
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border-subtle bg-surface-raised p-6">
      <h2 className="font-display text-xl font-semibold text-text-primary">Places &amp; themes</h2>
      <ul aria-label="Places and themes this memory belongs to" className="flex flex-col gap-4">
        {categories.map((category) => {
          const descId = `${baseId}-desc-${category.categoryId}`;
          const inputId = `${baseId}-name-${category.categoryId}`;
          const isRenaming =
            editing?.categoryId === category.categoryId && editing.mode === 'rename';
          const isReassigning =
            editing?.categoryId === category.categoryId && editing.mode === 'reassign';
          const others = categories.filter((other) => other.categoryId !== category.categoryId);

          return (
            <li
              key={category.categoryId}
              className="flex flex-col gap-2 rounded-xl bg-surface-sunken p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cx(
                    'inline-flex items-center rounded-full px-3 py-1 font-body text-base font-medium',
                    category.kind === 'place'
                      ? 'bg-sage-50 text-sage-700'
                      : 'bg-clay-50 text-clay-700',
                  )}
                >
                  {category.name}
                </span>
              </div>
              <p id={descId} className="font-body text-sm leading-relaxed text-text-secondary">
                {reasonText(category)}
              </p>

              {isRenaming ? (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor={inputId}
                      className="font-body text-sm font-medium text-text-primary"
                    >
                      Category name
                    </label>
                    <input
                      id={inputId}
                      type="text"
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      className="min-h-9 rounded-lg border border-border-interactive bg-surface-raised px-3 font-body text-base text-text-primary"
                    />
                  </div>
                  <button
                    type="button"
                    className={ACTION_BUTTON_CLASS}
                    onClick={() => commitRename(category)}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className={ACTION_BUTTON_CLASS}
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : isReassigning ? (
                <div
                  aria-describedby={descId}
                  className="flex flex-col gap-2 rounded-lg bg-surface-raised p-3"
                >
                  <p className="font-body text-sm text-text-secondary">
                    Move this memory to another group:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {others.length > 0 ? (
                      others.map((target) => (
                        <button
                          key={target.categoryId}
                          type="button"
                          className={ACTION_BUTTON_CLASS}
                          onClick={() => {
                            applyCorrection({
                              kind: 'reassign',
                              itemId: item.id,
                              fromCategoryId: category.categoryId,
                              toCategoryId: target.categoryId,
                            });
                            setEditing(null);
                          }}
                        >
                          Move to {target.name}
                        </button>
                      ))
                    ) : (
                      <p className="font-body text-sm text-text-secondary">
                        There are no other groups to move this to yet.
                      </p>
                    )}
                    <button
                      type="button"
                      className={ACTION_BUTTON_CLASS}
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div aria-describedby={descId} className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    aria-label={`Confirm ${category.name}`}
                    className={ACTION_BUTTON_CLASS}
                    onClick={() =>
                      applyCorrection({
                        kind: 'confirm',
                        itemId: item.id,
                        categoryId: category.categoryId,
                      })
                    }
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    aria-label={`Reassign ${category.name}`}
                    className={ACTION_BUTTON_CLASS}
                    onClick={() =>
                      setEditing({ categoryId: category.categoryId, mode: 'reassign' })
                    }
                  >
                    Reassign
                  </button>
                  <button
                    type="button"
                    aria-label={`Rename ${category.name}`}
                    className={ACTION_BUTTON_CLASS}
                    onClick={() => startRename(category)}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${category.name}`}
                    className={ACTION_BUTTON_CLASS}
                    onClick={() =>
                      applyCorrection({
                        kind: 'remove',
                        itemId: item.id,
                        categoryId: category.categoryId,
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
