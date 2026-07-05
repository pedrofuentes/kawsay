-- Kawsay catalog migration 005 — categorization + suggested-collection provenance
-- (ADR-0030 Decision 1, milestones M4-2 + M4-3). Purely ADDITIVE: two new tables
-- (categories, item_categories), provenance/lifecycle columns on the EXISTING
-- collections table, and a per-item category_status drain — NO items_fts column
-- change, so exact/semantic search (AC-7/AC-29) is byte-identical before and after.
--
-- Design (ADR-0030 Decision 1):
--   • categories holds one row per person/place/theme grouping. A stable
--     source_key (gazetteer place id / deterministic theme-cluster key) with a
--     partial-UNIQUE index makes an auto RE-CLUSTER an idempotent upsert rather
--     than a duplicate; user-created categories (NULL source_key) are exempt.
--   • item_categories is the explainable, correctable assignment (attached to an
--     item, ADR-0003 dedup-with-provenance): an 'auto' and a 'user' row for the
--     same (item, category) COEXIST — both retained, USER WINS at read time; a
--     user state='removed' row tombstones an auto membership so a later auto pass
--     can never resurrect it. The categorizer only ever writes source='auto' rows
--     and never touches source='user' rows (the same guard embedding-orchestrator
--     applies to its drain), so a re-cluster can never overwrite a correction (AC-30).
--   • collections gains ONE origin enum (provenance + lifecycle in a single column;
--     a redundant is_suggested boolean was REJECTED) and a category_id provenance
--     link (ON DELETE SET NULL — deleting a category orphans the link, never the
--     collection). DEFAULT 'user' backfills every existing collection as hand-made,
--     so today's behavior is unchanged.
--   • category_status is the categorization drain on items, mirroring
--     thumb_status/transcript_status/embed_status (pending → done | skipped | error).
--
-- Forward-only + idempotent: the runner applies this file exactly once
-- (user_version gate, ADR-0008); new objects additionally guard with IF NOT
-- EXISTS, ADD COLUMN backfills every row without a table rewrite, and no existing
-- data is read-modified or dropped. No items_fts column change ⇒ NO FTS rebuild.

-- ── CATEGORIES: one row per person/place/theme grouping ──────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,                                   -- UUIDv4
  kind       TEXT NOT NULL CHECK (kind IN ('person','place','theme')),
  name       TEXT NOT NULL,                                      -- human-readable label (auto-derived or user-renamed)
  -- Stable natural key so a RE-CLUSTER upserts (never duplicates) an auto category:
  --   place  -> the gazetteer place id;  theme -> a deterministic cluster key.
  -- NULL for a user-created category. UNIQUE where present (partial index below).
  source_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- One auto category per stable signal (idempotent re-cluster); user categories (NULL) exempt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_source_key
  ON categories(source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_categories_kind ON categories(kind);

-- ── ITEM_CATEGORIES: explainable, correctable assignment (attaches to an item) ─
-- Dedup-with-provenance (ADR-0003): an 'auto' and a 'user' row for the same
-- (item, category) COEXIST — both retained, USER WINS at read time. A user 'removed'
-- row tombstones an auto membership so a later auto pass can never resurrect it.
CREATE TABLE IF NOT EXISTS item_categories (
  item_id     TEXT NOT NULL REFERENCES items(id)      ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','user')),
  state       TEXT NOT NULL DEFAULT 'assigned' CHECK (state IN ('assigned','removed')),
  signal      TEXT CHECK (signal IN ('gps','theme-cluster','face-cluster','user')),  -- WHY (machine reason)
  confidence  REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),  -- auto: [0,1]; user: NULL (certain)
  explanation TEXT,                                    -- human-readable reason surfaced in the UI
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (item_id, category_id, source)           -- ≤1 auto + ≤1 user row per (item, category)
);
CREATE INDEX IF NOT EXISTS idx_item_categories_category ON item_categories(category_id);

-- ── COLLECTIONS provenance + curation lifecycle (M4-3) ───────────────────────
-- ONE origin enum captures both provenance and lifecycle (a redundant is_suggested
-- boolean was considered and REJECTED — two columns that must never drift). DEFAULT
-- 'user' backfills every existing collection as hand-made, so today's behavior is
-- unchanged. The runner's user_version gate makes these ADD COLUMNs run exactly once.
ALTER TABLE collections ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'
  CHECK (origin IN ('user','suggested','dismissed'));
-- The category a suggested/dismissed collection was derived FROM (NULL for hand-made).
-- ON DELETE SET NULL: deleting a category orphans the provenance link, never the collection.
ALTER TABLE collections ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_collections_category
  ON collections(category_id) WHERE category_id IS NOT NULL;

-- ── category_status drain on items (mirrors thumb_/transcript_/embed_status) ──
-- ADD COLUMN with a NOT NULL DEFAULT backfills every existing row to 'pending'
-- without a table rewrite; the CHECK pins the vocabulary. Does NOT touch the
-- items_fts column set, so the shipped FTS triggers stay valid and NO rebuild runs.
ALTER TABLE items ADD COLUMN category_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (category_status IN ('pending','done','skipped','error'));
CREATE INDEX IF NOT EXISTS idx_items_category_queue
  ON items(category_status) WHERE category_status = 'pending';
