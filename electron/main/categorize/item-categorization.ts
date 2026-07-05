// The renderer's READ + CORRECTION path over the categorizer's storage (T-M4-2h /
// #270). Where the categories-repo is the low-level assignment writer and the
// orchestrator (#269) is the batch clusterer, this service is the per-item seam the
// item view drives: `listForItem` resolves ONE item's explainable chips (place/theme
// with WHY + HOW-SURE, USER winning over AUTO, tombstones hidden), and
// `applyCorrection` turns a renderer correction (confirm / remove / reassign /
// rename) into the durable `source='user'` writes a later re-cluster can never
// clobber (AC-30). It owns NO IPC and NO worker — pure catalog access — so it
// unit-tests over an in-memory DB exactly like the categories-repo.
//
// The user-wins + tombstone resolution lives in SQL, not application branching: a
// row is shown iff it is `assigned` AND it is not an `auto` row shadowed by ANY
// `user` row for the same (item, category). So a user CONFIRM surfaces as
// `source='user'`, a user REMOVE hides the membership entirely, and a bare auto
// assignment shows through untouched — the same precedence `resolveAssignment`
// encodes, expressed set-wise for the whole item.

import type { CatalogDatabase } from '../db/connection';
import { createCategoriesRepo } from './categories-repo';
import type { CategorizationCorrectionDTO, ItemCategoryDTO } from '@shared/ipc/schemas';

/** The per-item read + correction service the #270 IPC handlers call into. */
export interface ItemCategorizationService {
  /**
   * Resolve ONE item's visible category chips: each `assigned` membership with its
   * winning provenance (source/signal/confidence/explanation), USER over AUTO, with
   * removed tombstones omitted. Ordered place-before-theme then by name, so the UI
   * paints a stable, calm list. Returns `[]` for an uncategorized item.
   */
  listForItem(itemId: string): ItemCategoryDTO[];
  /**
   * Apply a user correction and return the item's REFRESHED chips. `confirm` pins an
   * auto membership as a durable user decision; `remove` tombstones it; `reassign`
   * atomically tombstones the old category and assigns the new; `rename` relabels the
   * category row. Every write is `source='user'` (or a pure name update), so a later
   * re-cluster leaves the decision intact (AC-30).
   */
  applyCorrection(input: CategorizationCorrectionDTO): ItemCategoryDTO[];
}

/** Build the item-categorization read/correction service over an open, migrated catalog. */
export function createItemCategorizationService(db: CatalogDatabase): ItemCategorizationService {
  const categories = createCategoriesRepo(db);

  // A row is visible iff it is `assigned` AND it is not an `auto` row shadowed by a
  // `user` row for the same (item, category) — so a user row (confirm) wins and a
  // user tombstone (removed) hides both itself and the auto row. Place sorts before
  // theme (kind is alphabetical: place < theme), then name, then id for stability.
  const listStmt = db.prepare(`
    SELECT c.id          AS categoryId,
           c.kind        AS kind,
           c.name        AS name,
           ic.source     AS source,
           ic.signal     AS signal,
           ic.confidence AS confidence,
           ic.explanation AS explanation
      FROM item_categories ic
      JOIN categories c ON c.id = ic.category_id
     WHERE ic.item_id = @itemId
       AND ic.state = 'assigned'
       AND NOT (
         ic.source = 'auto'
         AND EXISTS (
           SELECT 1
             FROM item_categories u
            WHERE u.item_id = ic.item_id
              AND u.category_id = ic.category_id
              AND u.source = 'user'
         )
       )
     ORDER BY c.kind, c.name, c.id
  `);

  const renameStmt = db.prepare(`
    UPDATE categories SET name = @name WHERE id = @categoryId
  `);

  function listForItem(itemId: string): ItemCategoryDTO[] {
    return listStmt.all<ItemCategoryDTO>({ itemId });
  }

  // A reassign is two user writes (tombstone the old, assign the new) that must land
  // together — wrap them so a half-applied move can never be observed.
  const reassign = db.transaction(
    (itemId: string, fromCategoryId: string, toCategoryId: string) => {
      categories.setUserAssignment({ itemId, categoryId: fromCategoryId, state: 'removed' });
      categories.setUserAssignment({ itemId, categoryId: toCategoryId, state: 'assigned' });
    },
  );

  function applyCorrection(input: CategorizationCorrectionDTO): ItemCategoryDTO[] {
    switch (input.kind) {
      case 'confirm':
        categories.setUserAssignment({ itemId: input.itemId, categoryId: input.categoryId });
        break;
      case 'remove':
        categories.setUserAssignment({
          itemId: input.itemId,
          categoryId: input.categoryId,
          state: 'removed',
        });
        break;
      case 'reassign':
        reassign(input.itemId, input.fromCategoryId, input.toCategoryId);
        break;
      case 'rename':
        renameStmt.run({ name: input.name, categoryId: input.categoryId });
        break;
    }
    return listForItem(input.itemId);
  }

  return { listForItem, applyCorrection };
}
