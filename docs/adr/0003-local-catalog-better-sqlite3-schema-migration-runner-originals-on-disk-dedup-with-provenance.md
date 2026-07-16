### ADR-0003: Local catalog — better-sqlite3 schema + migration runner + originals-on-disk + dedup-with-provenance
**Date**: 2026-06-23
**Status**: Accepted — **initial schema (001) is gated by ADR-0008 (HUMAN-REQUIRED) before F3 code.**
**Tier**: auto-with-audit (this ADR is the audit note for the data-model). DB-migration authoring is
itself HUMAN-REQUIRED (AGENTS Boundaries) → see ADR-0008.

**Context**
v1 needs a local index over memories from many sources, with browse/timeline + search, **originals
preserved on disk**, **capture-date vs import-date**, and **deduplication that preserves provenance**
(the same photo from two sources stored once but with both origins kept — PRD §5.6; AC-14/AC-15).

**Decision**
**`better-sqlite3`** (synchronous, fast, native; WAL + tuned pragmas). The schema's defining choice:
**`items` is the deduplicated logical memory; `item_occurrences` records every (item, source)
occurrence** — so dedup (by **SHA-256 `content_hash`**, UNIQUE; NULLs distinct for messages) stores
bytes once while preserving provenance from **all** sources. Generated renditions live in
**`item_assets`** (never the original). **FTS5** external-content virtual table (`items_fts`, kept in
sync by triggers, `unicode61` tokenizer) powers search; targeted indexes power timeline browse.
Refinements (post red-team):

- **Originals stored once, content-addressed + reference-counted.** Folder imports are **referenced in
  place**; archive originals are copied **once** to `originals/<hash[0:2]>/<hash>[.ext]` and
  **reference-counted by occurrence** (each occurrence's `original_kind` ∈ {`in_place`,
  `content_addressed`,`none`}). There is **no single `items.stored_path`** — a memory's original is
  resolved through a *surviving* occurrence, so undoing one source never dangles or double-stores a
  deduped memory (AC-14; ARCHITECTURE §4.4).
- **Stable source identity.** `sources.source_key` (archive SHA-256 / canonical folder real path),
  `UNIQUE`, is the source's identity — **not** the per-run UUID. Re-importing the same source **reuses**
  its row, so `UNIQUE(item_id, source_id, source_ref)` makes **re-import idempotent** while genuinely
  new files still add occurrences.
- **Race-free dedup.** The write path uses `INSERT … ON CONFLICT(content_hash) DO UPDATE … RETURNING id`
  (and `ON CONFLICT(item_id,source_id,source_ref) DO NOTHING` for occurrences). Imports are **serialized
  through a single ingestion worker** (single-writer); the upsert keeps it correct within a batch and if
  concurrency is ever added.
- **Canonical `capture_date`.** Every importer writes an **ISO-8601 UTC** instant (EXIF, with no tz, is
  read as UTC), so the timeline's lexicographic DESC sort is chronological.
- **Keyset timeline pagination.** A **composite `(capture_date DESC, id DESC)`** index + keyset cursor
  (`id` the UNIQUE tiebreaker; `NULLS LAST` for undated rows) — never `OFFSET` — so equal-timestamp rows
  are never skipped/duplicated and NULL-date items still appear (AC-6/AC-8).
- **Cross-source search after dedup.** When a new occurrence joins a deduped item, its
  sender/caption/filename tokens are merged (de-duplicated) into `items.search_meta` via `UPDATE`, so
  the `items_fts_au` trigger re-syncs FTS (AC-7).

A **hand-written, forward-only, transactional migration runner** (recorded in a `migrations` table) is
used over an ORM.

**Alternatives considered**
- *`source_id` directly on `items` (the research's first-cut schema)* — **rejected**: it cannot
  represent dedup-with-provenance (one item, many origins). The `item_occurrences` join is the
  deliberate correction.
- *Per-source original copies (`originals/<source-id>/…`) + one `items.stored_path`* — **rejected**:
  double-stores cross-source duplicates and **dangles** the original on undo of the owning source
  (ADR-0008). Replaced by content-addressed, occurrence-refcounted storage.
- *Key occurrence identity on the per-run source UUID* — **rejected**: makes re-import create duplicate
  occurrences. The stable `source_key` makes `UNIQUE(item_id,source_id,source_ref)` actually idempotent.
- *`OFFSET`/`LIMIT` timeline paging* — rejected: skips/duplicates rows under concurrent inserts and at
  equal timestamps; keyset cursor chosen.
- *An ORM with auto-migrations (Drizzle/Prisma/TypeORM)* — rejected for a single-user local app; a tiny
  hand-written runner is simpler, fully inspectable, and avoids a heavy dep.
- *Store EXIF/source metadata as opaque JSON only* — rejected for queryable fields (date, type, GPS);
  raw per-occurrence fields are still kept as JSON in `item_occurrences.source_meta` for provenance.
- *Hash with SHA-1/MD5 (as some catalogs do)* — chose **SHA-256** for collision resistance on sensitive
  irreplaceable data.

**Consequences**
- ✅ "Nothing is silently dropped" holds even under dedup; the `Sources` provenance view is faithful.
- ✅ Fast browse/search at 10k–100k items; catalog is rebuildable from originals on disk.
- ✅ Undo is data-level and **lossless even for deduped memories**: remove a source's occurrences, drop
  items whose last occurrence is gone, and delete a content-addressed blob only when its **last**
  occurrence is removed — never touching in-place originals or source archives (AC-14).
- ✅ Re-import is idempotent (stable `source_key`); the timeline is stable under concurrent inserts
  (keyset); cross-source search survives dedup (search_meta re-denormalization).
- ⚠️ Forward-only migrations: schema rollback isn't supported in v1 (data-level undo is). Schema changes
  are HUMAN-REQUIRED and audited here.
- ⚠️ Per-occurrence text differences are not separately full-text-indexed in v1 (FTS indexes item-level
  `search_meta`, now the de-duplicated union of all occurrences' tokens); acceptable since media dedup is
  byte-identical and messages are 1:1 with items.
