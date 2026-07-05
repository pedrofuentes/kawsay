import { randomUUID } from 'node:crypto';
import type { CatalogDatabase } from '../db/connection';

// The curation data-access layer for suggested collections (ADR-0030 Decision 5,
// milestone M4-3, card M4-3b, issue #272). It is the WRITE half of suggested
// collections — the read half (deriving candidates) is the pure, read-only
// `suggestions-derive` module (#271). Every method here is an EXPLICIT user
// action taken in the review tray (#273 wires the IPC/UI); together they are the
// only code path that ever creates a `collections` row with a `suggested` or
// `dismissed` origin.
//
// ── AC-32 — a suggestion is NEVER silently materialised ──────────────────────
// Suggestions are DERIVED read-only and become a real `collections` row ONLY from
// an explicit action here (ADR-0030 / AC-32). The categorizer, the suggester and
// the derivation query write NOTHING to `collections`; this module is the single
// write path. That invariant is structural, not vigilance: `deriveSuggestion-
// Candidates` issues a lone SELECT, and the factory below is the only exported
// creator of `origin='suggested'`/`'dismissed'` rows — do NOT wire it into the
// orchestrator/suggester (it is called from the curation IPC only).
//
// ── The four lifecycle actions ───────────────────────────────────────────────
//   • accept  — materialise a candidate: INSERT one `origin='suggested'`
//               collection linked to the category, and copy the category's
//               EFFECTIVE members into `collection_items`.
//   • rename  — edit a collection's display name.
//   • merge   — fold one collection into another: move the merged-away
//               collection's members into the survivor (no duplicates), delete
//               the merged-away collection, and drop a `dismissed` tombstone for
//               its category so it is not re-proposed. The category row is intact.
//   • dismiss — drop a member-less `origin='dismissed'` collection as a durable
//               tombstone so the derivation never re-proposes the category.
//
// ── Effective membership (accept copies exactly what derivation counts) ──────
// A member is an item whose WINNING assignment row is 'assigned', resolved exactly
// like `categories-repo`'s resolver and `suggestions-derive`'s count: the USER row
// when one exists, else the AUTO row. So a user 'removed' tombstone HIDES an auto
// membership, a user 'assigned' confirms it WITHOUT double-counting the coexisting
// auto row, and a user-only 'assigned' adds one. The copy SELECT reproduces that
// "user wins" precedence with a correlated NOT EXISTS, emitting each item at most
// once (so the fresh collection can never collide on its (collection, item) PK).

/** Materialise a suggested collection from a place/theme category. */
export interface AcceptInput {
  /** The source category whose EFFECTIVE members are copied into the new collection. */
  categoryId: string;
  /** Display name for the collection; defaults to the category's current name. */
  name?: string;
  /** Pre-allocated collection UUID; generated when omitted. */
  id?: string;
}

/** Rename an existing collection. */
export interface RenameInput {
  collectionId: string;
  name: string;
}

/** Fold one collection into another. `from` is consumed; `into` survives. */
export interface MergeInput {
  /** The merged-away collection: its members move to `into`, then it is deleted and its category tombstoned. */
  fromCollectionId: string;
  /** The surviving collection that receives the merged members. */
  intoCollectionId: string;
}

/** Dismiss a suggestion: drop a durable tombstone so its category is not re-proposed. */
export interface DismissInput {
  /** The category to tombstone. */
  categoryId: string;
  /** Display name for the tombstone row; defaults to the category's current name. */
  name?: string;
  /** Pre-allocated tombstone UUID; generated when omitted. */
  id?: string;
}

/** The suggested-collection curation write layer over an open, migrated catalog database. */
export interface CurationRepo {
  /**
   * Materialise a candidate category as a real `origin='suggested'` collection
   * linked to it (`category_id`), copying the category's EFFECTIVE members into
   * `collection_items`. An explicit user action — the ONLY way a suggested row is
   * created (AC-32). Throws for an unknown category; returns the new collection id.
   */
  accept(input: AcceptInput): string;
  /** Rename a collection. Throws when no collection has that id. */
  rename(input: RenameInput): void;
  /**
   * Fold `from` into `into`: move `from`'s members into `into` (skipping items
   * `into` already holds — no duplicate `collection_items`), delete `from`, and —
   * when `from` was linked to a category — drop a `dismissed` tombstone for that
   * category so it is not re-proposed. The underlying `categories` row is left
   * intact. Throws on a self-merge or an unknown collection.
   */
  merge(input: MergeInput): void;
  /**
   * Drop a member-less `origin='dismissed'` collection linked to the category as a
   * durable tombstone (so `deriveSuggestionCandidates` never re-proposes it). An
   * explicit user action. Throws for an unknown category; returns the tombstone id.
   */
  dismiss(input: DismissInput): string;
}

interface CategoryNameRow {
  id: string;
  name: string;
}

interface CollectionRow {
  id: string;
  name: string;
  category_id: string | null;
}

/**
 * Build the suggested-collection curation write layer over an open, migrated
 * database. Single-write actions (rename, dismiss) run one prepared statement;
 * multi-write actions (accept, merge) run inside a `better-sqlite3` transaction so
 * the collection and its members — or the move, delete and tombstone — commit
 * atomically (the same discipline `embeddings-repo` applies to its upsert+drain).
 */
export function createCurationRepo(db: CatalogDatabase): CurationRepo {
  const selectCategoryStmt = db.prepare('SELECT id, name FROM categories WHERE id = @id');
  const selectCollectionStmt = db.prepare(
    'SELECT id, name, category_id FROM collections WHERE id = @id',
  );

  const insertSuggestedStmt = db.prepare(`
    INSERT INTO collections (id, name, origin, category_id)
    VALUES (@id, @name, 'suggested', @categoryId)
  `);
  const insertDismissedStmt = db.prepare(`
    INSERT INTO collections (id, name, origin, category_id)
    VALUES (@id, @name, 'dismissed', @categoryId)
  `);
  // Copy the category's EFFECTIVE members into a FRESH collection. The predicate is
  // the resolver's "user wins": an item's user row (when present) else its auto
  // row, counted iff 'assigned' — so a user 'removed' tombstone is excluded and a
  // confirmed member is emitted once (never doubled). Each item appears at most
  // once, so a plain INSERT can never collide on the (collection_id, item_id) PK.
  const copyEffectiveMembersStmt = db.prepare(`
    INSERT INTO collection_items (collection_id, item_id)
    SELECT @collectionId, ic.item_id
      FROM item_categories ic
     WHERE ic.category_id = @categoryId
       AND ic.state = 'assigned'
       AND (
         ic.source = 'user'
         OR NOT EXISTS (
           SELECT 1 FROM item_categories u
            WHERE u.item_id = ic.item_id
              AND u.category_id = ic.category_id
              AND u.source = 'user'
         )
       )
  `);
  // Move members into the survivor. OR IGNORE relies on the (collection_id,
  // item_id) PK to skip an item the survivor already holds — the "no duplicate
  // collection_items" guarantee.
  const moveMembersStmt = db.prepare(`
    INSERT OR IGNORE INTO collection_items (collection_id, item_id)
    SELECT @intoId, item_id FROM collection_items WHERE collection_id = @fromId
  `);
  // Deleting the merged-away collection cascades its collection_items (already
  // copied to the survivor) via ON DELETE CASCADE; it never touches `categories`.
  const deleteCollectionStmt = db.prepare('DELETE FROM collections WHERE id = @id');
  const renameStmt = db.prepare(`
    UPDATE collections SET name = @name, updated_at = datetime('now') WHERE id = @collectionId
  `);

  // accept: insert the suggested collection, then copy its effective members —
  // atomically, so a collection never persists without (or before) its members.
  const acceptTxn = db.transaction((collectionId: string, categoryId: string, name: string) => {
    insertSuggestedStmt.run({ id: collectionId, name, categoryId });
    copyEffectiveMembersStmt.run({ collectionId, categoryId });
  });

  // merge: move members, delete the merged-away collection, and — when it was
  // linked to a category — tombstone that category (using the collection's own
  // display name; the name is cosmetic, derivation matches only origin +
  // category_id). Atomic so the move/delete/tombstone never partially apply.
  const mergeTxn = db.transaction(
    (fromId: string, intoId: string, fromName: string, fromCategoryId: string | null) => {
      moveMembersStmt.run({ fromId, intoId });
      deleteCollectionStmt.run({ id: fromId });
      if (fromCategoryId !== null) {
        insertDismissedStmt.run({ id: randomUUID(), name: fromName, categoryId: fromCategoryId });
      }
    },
  );

  return {
    accept(input) {
      // Load the category first: it validates the FK (a suggested collection can
      // never link a non-existent category) AND supplies the default name.
      const category = selectCategoryStmt.get<CategoryNameRow>({ id: input.categoryId });
      if (category === undefined) {
        throw new Error(`accept: unknown category ${input.categoryId}`);
      }
      const collectionId = input.id ?? randomUUID();
      acceptTxn(collectionId, input.categoryId, input.name ?? category.name);
      return collectionId;
    },

    rename(input) {
      const result = renameStmt.run({ collectionId: input.collectionId, name: input.name });
      if (result.changes === 0) {
        throw new Error(`rename: unknown collection ${input.collectionId}`);
      }
    },

    merge(input) {
      if (input.fromCollectionId === input.intoCollectionId) {
        throw new Error('merge: fromCollectionId and intoCollectionId must differ');
      }
      const from = selectCollectionStmt.get<CollectionRow>({ id: input.fromCollectionId });
      if (from === undefined) {
        throw new Error(`merge: unknown collection ${input.fromCollectionId}`);
      }
      const into = selectCollectionStmt.get<CollectionRow>({ id: input.intoCollectionId });
      if (into === undefined) {
        throw new Error(`merge: unknown collection ${input.intoCollectionId}`);
      }
      mergeTxn(input.fromCollectionId, input.intoCollectionId, from.name, from.category_id);
    },

    dismiss(input) {
      const category = selectCategoryStmt.get<CategoryNameRow>({ id: input.categoryId });
      if (category === undefined) {
        throw new Error(`dismiss: unknown category ${input.categoryId}`);
      }
      const tombstoneId = input.id ?? randomUUID();
      insertDismissedStmt.run({
        id: tombstoneId,
        name: input.name ?? category.name,
        categoryId: input.categoryId,
      });
      return tombstoneId;
    },
  };
}
