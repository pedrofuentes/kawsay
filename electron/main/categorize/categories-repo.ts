import { randomUUID } from 'node:crypto';
import type { CatalogDatabase } from '../db/connection';

// The categories + assignments data-access layer for M4-2 categorization
// (ADR-0030 Decisions 1 & 4, milestone M4-2). It is the storage half of the
// categorizer, mirroring the embeddings-repo mould: a typed interface over
// prepared statements with named-param binding, exercised by unit tests against
// a REAL in-memory catalog (no DB mocking). It owns two shapes:
//
//   1. `categories` — one row per person/place/theme grouping. A stable
//      `source_key` (place = `place:<geonameid>`, theme = `theme:<sha256>`) with
//      the migration's partial-UNIQUE index makes an auto RE-CLUSTER an idempotent
//      UPSERT rather than a duplicate; a NULL `source_key` (a user-created
//      category) is EXEMPT from the collapse and always yields a fresh row.
//   2. `item_categories` — the explainable, correctable assignment attached to an
//      item (dedup-with-provenance, ADR-0003). An `auto` and a `user` row for the
//      same (item, category) COEXIST — both retained; USER WINS at read time. A
//      `state='removed'` user row TOMBSTONES an auto membership so a later auto
//      pass can never resurrect it.
//
// Correction durability (AC-30) falls out of the schema, not of application
// vigilance: `assignAuto` only ever writes `source='auto'` and `setUserAssignment`
// only ever writes `source='user'`, and the primary key is (item_id, category_id,
// source). So an auto re-cluster's UPSERT can only ever conflict with the EXISTING
// auto row — the user row (a different PK) is structurally untouchable — the same
// drain-safety guard embedding-orchestrator applies to its `embed_status` writes.
//
// This module writes NOTHING to the `category_status` drain: an item is 1:many
// with categories (and a signal-less item is `skipped`), so flipping an item
// `done` is a per-item decision the orchestrator (#269) makes after folding the
// item into every cluster — never a per-assignment side effect here.

/** The category groupings (mirrors the categories.kind CHECK). */
export const CATEGORY_KINDS = ['person', 'place', 'theme'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

/** Assignment provenance — `user` always wins over `auto` at read time (mirrors the source CHECK). */
export const ASSIGNMENT_SOURCES = ['auto', 'user'] as const;
export type AssignmentSource = (typeof ASSIGNMENT_SOURCES)[number];

/** Assignment lifecycle — `removed` is a tombstone that hides membership (mirrors the state CHECK). */
export const ASSIGNMENT_STATES = ['assigned', 'removed'] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

/** WHY an assignment was made — the machine reason (mirrors the signal CHECK). */
export const ASSIGNMENT_SIGNALS = ['gps', 'theme-cluster', 'face-cluster', 'user'] as const;
export type AssignmentSignal = (typeof ASSIGNMENT_SIGNALS)[number];

/** A category to upsert. A stable `sourceKey` makes a re-cluster idempotent; NULL/omitted → a user category. */
export interface CategoryUpsertInput {
  /** Pre-allocated UUID; generated when omitted (only used on a fresh insert). */
  id?: string;
  kind: CategoryKind;
  /** Human-readable label (auto-derived or user-renamed); refreshed on re-cluster. */
  name: string;
  /** Stable natural key (`place:<geonameid>` / `theme:<sha256>`). NULL/omitted → exempt from the collapse. */
  sourceKey?: string | null;
}

/** A category as loaded back from storage. */
export interface CategoryRow {
  id: string;
  kind: CategoryKind;
  name: string;
  sourceKey: string | null;
  /** Canonical ISO-8601 UTC instant the category was first created. */
  createdAt: string;
}

/** An AUTO assignment written by the categorizer (always `source='auto'`, `state='assigned'`). */
export interface AutoAssignmentInput {
  itemId: string;
  categoryId: string;
  /** The machine reason (`gps` / `theme-cluster` / `face-cluster`). */
  signal: AssignmentSignal;
  /** Auto confidence in [0, 1]; NULL/omitted when not scored. */
  confidence?: number | null;
  /** Human-readable reason surfaced in the UI (e.g. "Near Cusco, Perú (photo GPS)"). */
  explanation?: string | null;
}

/** A USER correction (always `source='user'`): `state='assigned'` confirms, `state='removed'` tombstones. */
export interface UserAssignmentInput {
  itemId: string;
  categoryId: string;
  /** `assigned` (confirm) or `removed` (tombstone) — defaults to `assigned`. */
  state?: AssignmentState;
  /** WHY — defaults to `user` (a manual decision). */
  signal?: AssignmentSignal;
  /** A user decision is certain → confidence defaults to NULL. */
  confidence?: number | null;
  explanation?: string | null;
}

/** The resolved EFFECTIVE assignment for one (item, category): the winning row + its provenance. */
export interface EffectiveAssignment {
  itemId: string;
  categoryId: string;
  /** Which row decided the effective state (`user` wins over `auto`). */
  source: AssignmentSource;
  /** `assigned` → a member; `removed` → tombstoned (the caller reads it as NOT a member). */
  state: AssignmentState;
  signal: AssignmentSignal | null;
  confidence: number | null;
  explanation: string | null;
}

/** The categories + assignments data-access layer over an open, migrated catalog database. */
export interface CategoriesRepo {
  /**
   * Idempotently upsert a category by its stable `source_key`: a re-cluster of the
   * SAME signal updates (never duplicates) the existing row and returns its id. A
   * NULL/omitted `source_key` is exempt from the collapse — every call is a fresh
   * user category. Returns the stable category id.
   */
  upsertCategory(input: CategoryUpsertInput): string;
  /** Load a category by id, or null when none exists. */
  getCategory(id: string): CategoryRow | null;
  /** Load the (single) category for a non-null `source_key`, or null when none exists. */
  getCategoryBySourceKey(sourceKey: string): CategoryRow | null;
  /**
   * Write (upsert) an AUTO assignment for (item, category): `source='auto'`,
   * `state='assigned'`. A re-cluster overwrites the existing auto row and can NEVER
   * touch a coexisting `source='user'` row (the PK includes `source`). Throws on an
   * unknown item/category (FK) — an assignment never precedes its item or category.
   */
  assignAuto(input: AutoAssignmentInput): void;
  /**
   * Write (upsert) a USER correction for (item, category): `source='user'`,
   * `state='assigned'` (confirm) or `state='removed'` (tombstone). It overwrites the
   * existing user row and never touches the coexisting auto row.
   */
  setUserAssignment(input: UserAssignmentInput): void;
  /**
   * Resolve the EFFECTIVE assignment for (item, category): the user row if one
   * exists (assigned or a removed tombstone), else the auto row, else null. The
   * caller treats `state='removed'` as NOT a member; the losing row is retained
   * underneath for provenance.
   */
  resolveAssignment(itemId: string, categoryId: string): EffectiveAssignment | null;
}

interface RawCategoryRow {
  id: string;
  kind: CategoryKind;
  name: string;
  source_key: string | null;
  created_at: string;
}

interface RawAssignmentRow {
  item_id: string;
  category_id: string;
  source: AssignmentSource;
  state: AssignmentState;
  signal: AssignmentSignal | null;
  confidence: number | null;
  explanation: string | null;
}

function toCategoryRow(row: RawCategoryRow): CategoryRow {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    sourceKey: row.source_key,
    createdAt: row.created_at,
  };
}

/**
 * Build the categories + assignments data-access layer over an open, migrated
 * database. Each operation is a single prepared statement (one SQLite write per
 * call — no multi-write transaction is needed, unlike the embeddings upsert which
 * also flips a drain flag).
 */
export function createCategoriesRepo(db: CatalogDatabase): CategoriesRepo {
  // Idempotent upsert by the partial-UNIQUE index on source_key. The conflict
  // target repeats the index's WHERE so SQLite targets the partial index; a NULL
  // source_key matches no index entry, so it can never conflict — a user category
  // always inserts fresh. RETURNING id yields the existing id on conflict (the
  // re-cluster collapse) or the new id on insert.
  const upsertCategoryStmt = db.prepare(`
    INSERT INTO categories (id, kind, name, source_key)
    VALUES (@id, @kind, @name, @sourceKey)
    ON CONFLICT(source_key) WHERE source_key IS NOT NULL DO UPDATE SET
      name = excluded.name
    RETURNING id
  `);
  const selectCategoryStmt = db.prepare(`
    SELECT id, kind, name, source_key, created_at FROM categories WHERE id = @id
  `);
  const selectCategoryByKeyStmt = db.prepare(`
    SELECT id, kind, name, source_key, created_at FROM categories WHERE source_key = @sourceKey
  `);
  // AUTO write: source is the LITERAL 'auto' (never a param), so this statement can
  // only ever create or update the auto row for (item, category). The PK
  // (item_id, category_id, source) makes the ON CONFLICT collapse onto that same
  // auto row — a user row is a different PK and is structurally untouchable (AC-30).
  const assignAutoStmt = db.prepare(`
    INSERT INTO item_categories (item_id, category_id, source, state, signal, confidence, explanation)
    VALUES (@itemId, @categoryId, 'auto', 'assigned', @signal, @confidence, @explanation)
    ON CONFLICT(item_id, category_id, source) DO UPDATE SET
      state       = excluded.state,
      signal      = excluded.signal,
      confidence  = excluded.confidence,
      explanation = excluded.explanation,
      created_at  = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);
  // USER write: symmetric to the auto write with the LITERAL 'user' source, so it
  // only ever touches the user row and leaves any coexisting auto row intact.
  const setUserStmt = db.prepare(`
    INSERT INTO item_categories (item_id, category_id, source, state, signal, confidence, explanation)
    VALUES (@itemId, @categoryId, 'user', @state, @signal, @confidence, @explanation)
    ON CONFLICT(item_id, category_id, source) DO UPDATE SET
      state       = excluded.state,
      signal      = excluded.signal,
      confidence  = excluded.confidence,
      explanation = excluded.explanation,
      created_at  = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);
  // Effective resolution: user row wins (source='user' sorts to 1, DESC → first),
  // else the auto row; LIMIT 1 picks the winner and the loser stays retained.
  const resolveStmt = db.prepare(`
    SELECT item_id, category_id, source, state, signal, confidence, explanation
      FROM item_categories
     WHERE item_id = @itemId AND category_id = @categoryId
     ORDER BY (source = 'user') DESC
     LIMIT 1
  `);

  return {
    upsertCategory(input) {
      const row = upsertCategoryStmt.get<{ id: string }>({
        id: input.id ?? randomUUID(),
        kind: input.kind,
        name: input.name,
        sourceKey: input.sourceKey ?? null,
      });
      if (row === undefined) {
        // DO UPDATE always yields a RETURNING row (insert or conflict); an absent
        // row would mean the statement silently no-op'd — fail loud rather than
        // hand back an undefined id.
        throw new Error('upsertCategory: expected a RETURNING id row');
      }
      return row.id;
    },

    getCategory(id) {
      const row = selectCategoryStmt.get<RawCategoryRow>({ id });
      return row === undefined ? null : toCategoryRow(row);
    },

    getCategoryBySourceKey(sourceKey) {
      const row = selectCategoryByKeyStmt.get<RawCategoryRow>({ sourceKey });
      return row === undefined ? null : toCategoryRow(row);
    },

    assignAuto(input) {
      assignAutoStmt.run({
        itemId: input.itemId,
        categoryId: input.categoryId,
        signal: input.signal,
        confidence: input.confidence ?? null,
        explanation: input.explanation ?? null,
      });
    },

    setUserAssignment(input) {
      setUserStmt.run({
        itemId: input.itemId,
        categoryId: input.categoryId,
        state: input.state ?? 'assigned',
        signal: input.signal ?? 'user',
        confidence: input.confidence ?? null,
        explanation: input.explanation ?? null,
      });
    },

    resolveAssignment(itemId, categoryId) {
      const row = resolveStmt.get<RawAssignmentRow>({ itemId, categoryId });
      if (row === undefined) return null;
      return {
        itemId: row.item_id,
        categoryId: row.category_id,
        source: row.source,
        state: row.state,
        signal: row.signal,
        confidence: row.confidence,
        explanation: row.explanation,
      };
    },
  };
}
