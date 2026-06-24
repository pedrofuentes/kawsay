-- Kawsay catalog — initial schema (ARCHITECTURE §4.2, ADR-0003).
-- The defining choice: `items` is the deduplicated logical memory; the
-- `item_occurrences` table records every (item, source) occurrence — so dedup
-- stores the bytes once while preserving provenance from EVERY source
-- (dedup-with-provenance, AC-14/AC-15, PRD §5.6).

-- ── migrations bookkeeping ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── SOURCES: one row per logical source (STABLE across re-imports) ───────
CREATE TABLE sources (
  id            TEXT PRIMARY KEY,                          -- UUIDv4 — STABLE: reused (not regenerated)
                                                           --   on re-import when source_key matches
  -- STABLE source identity (NOT a per-run id): SHA-256 of the archive file for archive sources;
  -- the canonical absolute real path for folder sources. Re-importing the same source REUSES this
  -- row, so UNIQUE(item_id, source_id, source_ref) makes re-import idempotent (no duplicate
  -- occurrences) while genuinely-new files still add occurrences.
  source_key    TEXT NOT NULL UNIQUE,
  type          TEXT NOT NULL CHECK (type IN
                  ('folder','whatsapp','google_takeout','facebook','linkedin')),
  label         TEXT NOT NULL,                             -- "Mum's WhatsApp backup"
  origin_path   TEXT,                                      -- the original .zip / chosen folder (untouched)
  root_path     TEXT,                                      -- folder root, or extracted-archive copy root
  imported_at   TEXT NOT NULL DEFAULT (datetime('now')),   -- updated on each re-import
  item_count    INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                  ('pending','extracting','ingesting','done','error','undone'))
);

-- ── ITEMS: the deduplicated logical memory ───────────────────────────────
CREATE TABLE items (
  id               TEXT PRIMARY KEY,                       -- UUIDv4
  media_type       TEXT NOT NULL CHECK (media_type IN
                     ('photo','video','audio','document','message')),
  mime_type        TEXT,

  -- Deduplication key. SHA-256 hex of file bytes. NULL for pure messages and
  -- until hashing completes. SQLite treats NULLs as DISTINCT, so many message
  -- rows with NULL hash coexist; only non-null hashes dedupe.
  content_hash     TEXT UNIQUE,

  -- NOTE: there is deliberately NO single `stored_path` on items. A memory's original is resolved at
  -- READ time through a SURVIVING `item_occurrences` row (§4.4) — so undoing one source can never
  -- dangle a deduped item that still lives in another source. `original_ext` is the extension used to
  -- build the content-addressed blob path for archive originals (folder originals are referenced in
  -- place; pure messages have none).
  original_ext     TEXT,                                   -- e.g. '.jpg'; NULL for pure messages
  file_size_bytes  INTEGER,

  -- Temporal: capture/taken date vs import date are distinct (PRD AC-2/AC-11).
  -- capture_date is a CANONICAL ISO-8601 UTC instant (e.g. '2019-06-14T13:45:30.000Z') written by
  -- EVERY importer (EXIF, sidecar, filename, mtime, import) so lexicographic DESC == chronological
  -- DESC (§3.2). EXIF has no timezone → read as UTC. NULL when no date is knowable.
  capture_date     TEXT,                                   -- ISO-8601 UTC, best available; NULL if unknown
  capture_date_src TEXT CHECK (capture_date_src IN
                     ('exif','sidecar','filename','mtime','message','import')),
  import_date      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),  -- ISO-8601 UTC

  -- Geometry / media
  width INTEGER, height INTEGER, duration_sec REAL, orientation INTEGER,

  -- EXIF (nullable; photos/videos)
  camera_make TEXT, camera_model TEXT,
  gps_lat REAL, gps_lon REAL, gps_alt REAL,               -- catalogued locally only (no online maps, §7/PRD §7)

  -- User-facing + search feed
  title        TEXT,
  description  TEXT,                                       -- message body / caption / doc snippet
  search_meta  TEXT,                                       -- denormalized FTS feed: filenames, sender(s), subject
  is_favourite INTEGER NOT NULL DEFAULT 0 CHECK (is_favourite IN (0,1)),

  -- Thumbnail queue-drain flag (rendition paths live in item_assets)
  thumb_status TEXT NOT NULL DEFAULT 'pending' CHECK (thumb_status IN
                 ('pending','done','error','skipped')),

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── ITEM_OCCURRENCES: provenance — one row per (item, source) occurrence ──
-- THIS is dedup-with-provenance: dedup keeps one `items` row; we keep an
-- occurrence row for EVERY source the bytes/message arrived from.
CREATE TABLE item_occurrences (
  id            TEXT PRIMARY KEY,                          -- UUIDv4
  item_id       TEXT NOT NULL REFERENCES items(id)   ON DELETE CASCADE,
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_ref    TEXT NOT NULL,                             -- path/index within that source (provenance)

  -- How THIS occurrence's original bytes are retained — drives the content-addressed reference
  -- count on undo (§4.4):
  --   'in_place'          folder import: original_path is the user's file; NEVER copied
  --   'content_addressed' archive import: bytes copied ONCE to originals/<hash[0:2]>/<hash>[.ext]
  --   'none'              pure message/post (no file-backed original)
  original_kind TEXT NOT NULL DEFAULT 'none' CHECK (original_kind IN
                  ('in_place','content_addressed','none')),
  original_path TEXT,                                      -- in_place: absolute external path; else NULL

  author        TEXT,                                      -- sender/poster per this source
  occurred_at   TEXT,                                      -- ISO-8601 UTC per this source (chat/post time)
  source_meta   TEXT,                                      -- JSON: raw per-occurrence fields
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, source_id, source_ref)                 -- idempotent re-import (stable source_id, §4.4)
);

-- ── ITEM_ASSETS: generated renditions (NEVER the original) ───────────────
CREATE TABLE item_assets (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('thumbnail','poster','waveform')),
  path       TEXT NOT NULL,                                -- under <library>/derived/...
  width INTEGER, height INTEGER, byte_size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, kind)
);

-- ── TAGS / COLLECTIONS (browse organization; v1 minimal) ─────────────────
CREATE TABLE tags (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE item_tags (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);
CREATE TABLE collections (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  cover_item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL REFERENCES items(id)       ON DELETE CASCADE,
  position      INTEGER,
  added_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (collection_id, item_id)
);

-- ── FTS5 full-text search (external-content over items) ──────────────────
CREATE VIRTUAL TABLE items_fts USING fts5(
  title, description, search_meta,
  content='items', content_rowid='rowid', tokenize='unicode61'   -- handles ES/PT diacritics
);
CREATE TRIGGER items_fts_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, description, search_meta)
  VALUES (new.rowid, new.title, new.description, new.search_meta);
END;
CREATE TRIGGER items_fts_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, description, search_meta)
  VALUES ('delete', old.rowid, old.title, old.description, old.search_meta);
END;
CREATE TRIGGER items_fts_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, description, search_meta)
  VALUES ('delete', old.rowid, old.title, old.description, old.search_meta);
  INSERT INTO items_fts(rowid, title, description, search_meta)
  VALUES (new.rowid, new.title, new.description, new.search_meta);
END;

-- ── Indexes (timeline browse, dedup, queue drain, joins) ─────────────────
-- Timeline keyset pagination: composite (capture_date DESC, id DESC) — `id` is the UNIQUE tiebreaker
-- so equal-timestamp rows are never skipped/duplicated across pages (AC-6/AC-8). NULL capture_date
-- sorts LAST (undated items still appear, after all dated rows).
CREATE INDEX idx_items_timeline     ON items(capture_date DESC, id DESC);
CREATE INDEX idx_items_media_type   ON items(media_type);
CREATE INDEX idx_items_thumb_queue  ON items(thumb_status) WHERE thumb_status = 'pending';
CREATE INDEX idx_items_favourite    ON items(is_favourite) WHERE is_favourite = 1;
CREATE INDEX idx_items_gps          ON items(gps_lat, gps_lon)
  WHERE gps_lat IS NOT NULL AND gps_lon IS NOT NULL;
CREATE INDEX idx_occ_item   ON item_occurrences(item_id);
CREATE INDEX idx_occ_source ON item_occurrences(source_id);
CREATE INDEX idx_assets_item ON item_assets(item_id);
CREATE INDEX idx_item_tags_item ON item_tags(item_id);
CREATE INDEX idx_item_tags_tag  ON item_tags(tag_id);
