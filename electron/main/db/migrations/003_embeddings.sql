-- Kawsay catalog migration 003 — on-device semantic-search foundation
-- (ADR-0029 Decisions 1 & 4, milestone M4-1). Adds the storage + drain the
-- later embedding slice (M4-1b) fills with a real on-device model. This slice is
-- purely ADDITIVE infrastructure: it embeds nothing, adds no dependency, and does
-- NOT change the live FTS search path — items_fts is left completely untouched.
--
-- Design (ADR-0029):
--   • item_embeddings holds DERIVED float32 vectors (one row per item + model),
--     stored as a little-endian float32 BLOB — a removable rendition like a
--     thumbnail or transcript (AC-14), FK ON DELETE CASCADE so a vector can never
--     outlive its item. UNIQUE(item_id, model_id) makes re-embedding a REPLACE and
--     keeps provenance explicit (model_id + dim + kind).
--   • A per-item embed_status drain on items mirrors thumb_status (001) /
--     transcript_status (002): pending -> done | error | skipped, so the existing
--     catalog can be back-filled off-thread.
--   • items_fts is DELIBERATELY untouched: the semantic index is separate from
--     FTS, so — unlike the transcript case (ADR-0027 §5) — there is NO FTS
--     column-set change and NO destructive drop/rebuild. Exact search (AC-7) is
--     byte-identical before and after this migration (AC-29).
--
-- Forward-only + idempotent: the runner applies this file exactly once
-- (user_version gate, ADR-0008); new objects additionally guard with IF NOT
-- EXISTS, and no existing data is read-modified or dropped.

-- ── ITEM_EMBEDDINGS: derived float32 vectors (one row per item + model) ──────
CREATE TABLE IF NOT EXISTS item_embeddings (
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,  -- attaches to the item; never a new item
  kind       TEXT NOT NULL DEFAULT 'text'                           -- vector provenance (ADR-0029); 'face' is a later, gated slice
               CHECK (kind IN ('text','face')),
  model_id   TEXT NOT NULL,                                         -- which model produced the vector (provenance + comparability guard)
  dim        INTEGER NOT NULL,                                      -- vector length; equals the BLOB byte length / 4
  vector     BLOB NOT NULL,                                         -- float32 little-endian, dim*4 bytes
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),  -- canonical ISO-8601 UTC instant
  UNIQUE (item_id, model_id)                                        -- re-embedding REPLACES (no duplicate vectors per model)
);

-- Lookups + cascade by item (the FK target column). UNIQUE(item_id, model_id)
-- already covers item_id-prefix scans, but the explicit index documents the
-- access path and keeps ON DELETE CASCADE efficient.
CREATE INDEX IF NOT EXISTS idx_item_embeddings_item ON item_embeddings(item_id);

-- ── embed_status drain signal on items (analogous to thumb_status) ───────────
-- ADD COLUMN with a NOT NULL DEFAULT backfills every existing row to 'pending'
-- without a table rewrite; the CHECK pins the status vocabulary. This does NOT
-- change the items_fts column set (title/description/search_meta), so the shipped
-- FTS triggers stay valid and NO items_fts rebuild is required (ADR-0029).
ALTER TABLE items ADD COLUMN embed_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (embed_status IN ('pending','done','error','skipped'));

-- Drain index: items awaiting embedding (mirrors idx_items_thumb_queue).
CREATE INDEX IF NOT EXISTS idx_items_embed_queue
  ON items(embed_status) WHERE embed_status = 'pending';
