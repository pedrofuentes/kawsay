-- Kawsay catalog migration 002 — transcript storage + FTS indexing (ADR-0027 §5,
-- AC-19, issue #135). Spoken words from voice notes / audio / video become a
-- first-class, searchable part of the archive.
--
-- Design (ADR-0027 Decision 5):
--   • Transcripts ATTACH to the EXISTING media item — never a new/duplicate item
--     (dedup-with-provenance, ADR-0003). A normalized `transcripts` table is keyed
--     1:1 by `item_id` (PK + FK ON DELETE CASCADE), so a transcript can never
--     outlive or duplicate its item.
--   • A per-item `transcript_status` drain signal on `items` mirrors the existing
--     `thumb_status` queue (pending → done | failed | skipped). Pre-existing rows
--     backfill to 'pending', so already-imported audio/video become eligible.
--   • Spoken words are made searchable by feeding the transcript text into the
--     EXISTING FTS-synced `search_meta` column (whose semantics are already a
--     "denormalized FTS feed") — NOT the message-body `description`. The feed
--     itself happens at persistence time (transcript-repo): an UPDATE of
--     `items.search_meta` fires the shipped `items_fts_au` trigger, keeping the
--     external-content FTS5 index in sync. Because we REUSE search_meta, the
--     `items_fts` COLUMN SET is unchanged — so NO destructive DROP+CREATE of the
--     virtual table or its triggers is required (that cost applies only when a
--     dedicated FTS column is added, ADR-0027 §5).
--
-- Forward-only + idempotent: the migration runner applies this file exactly once
-- (user_version gate, ADR-0008); the new objects additionally guard with
-- IF NOT EXISTS, and no existing data is read-modified or dropped.

-- ── transcript_status drain signal on items (analogous to thumb_status) ──────
-- ADD COLUMN with a NOT NULL DEFAULT backfills every existing row to 'pending'
-- without a table rewrite; the CHECK pins the status vocabulary.
ALTER TABLE items ADD COLUMN transcript_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (transcript_status IN ('pending','done','failed','skipped'));

-- ── TRANSCRIPTS: one normalized row per transcribed item (attached 1:1) ──────
CREATE TABLE IF NOT EXISTS transcripts (
  item_id    TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,  -- attaches to the item; never a new item
  text       TEXT NOT NULL,                                            -- full transcript (also fed into items.search_meta)
  segments   TEXT,                                                     -- JSON: [{startMs,endMs,text}] per-segment offsets (AC-19)
  language   TEXT,                                                     -- whisper-detected language, or NULL
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Drain index: items awaiting transcription (mirrors idx_items_thumb_queue) ─
CREATE INDEX IF NOT EXISTS idx_items_transcript_queue
  ON items(transcript_status) WHERE transcript_status = 'pending';

-- ── External-content FTS5 re-sync (ADR-0027 §5) ──────────────────────────────
-- Re-assert the items_fts index over the whole catalog after the items ALTER.
-- We reuse the already-indexed `search_meta` column, so the FTS column set is
-- unchanged and the shipped triggers stay valid; this 'rebuild' is the FTS5
-- blessed, idempotent way to guarantee the external-content index is consistent
-- with the (now-altered) content table. Cheap and safe on a fresh or populated DB.
INSERT INTO items_fts(items_fts) VALUES('rebuild');
