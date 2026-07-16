import { randomUUID } from 'node:crypto';
import type {
  AssetKind,
  CaptureDateSource,
  MediaType,
  OriginalKind,
  SourceType,
} from '@shared/catalog';
import type { CatalogDatabase } from './connection';

// ── Inputs ────────────────────────────────────────────────────────────────

/** A deduplicated logical memory (ARCHITECTURE §4.2 `items`). */
export interface ItemInput {
  /** Pre-allocated UUID; generated when omitted. */
  id?: string;
  mediaType: MediaType;
  mimeType?: string | null;
  /** SHA-256 hex of the file bytes; NULL for pure messages (never deduped). */
  contentHash?: string | null;
  originalExt?: string | null;
  fileSizeBytes?: number | null;
  /** Canonical ISO-8601 UTC instant (see {@link toIsoUtc}); NULL if unknown. */
  captureDate?: string | null;
  captureDateSrc?: CaptureDateSource | null;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
  orientation?: number | null;
  cameraMake?: string | null;
  cameraModel?: string | null;
  gpsLat?: number | null;
  gpsLon?: number | null;
  gpsAlt?: number | null;
  title?: string | null;
  description?: string | null;
  /** Denormalized FTS feed (filenames, senders, subjects). */
  searchMeta?: string | null;
}

/** A provenance record: one (item, source) occurrence (dedup-with-provenance). */
export interface OccurrenceInput {
  id?: string;
  itemId: string;
  sourceId: string;
  /** Path/index within that source — the per-source provenance key. */
  sourceRef: string;
  originalKind?: OriginalKind;
  /** `in_place` external absolute path; NULL otherwise. */
  originalPath?: string | null;
  author?: string | null;
  occurredAt?: string | null;
  sourceMeta?: string | null;
}

export interface OccurrenceResult {
  id: string;
  /** False when an identical occurrence already existed (idempotent re-import). */
  inserted: boolean;
}

/** A generated rendition under derived/ (never the original). */
export interface AssetInput {
  id?: string;
  itemId: string;
  kind: AssetKind;
  path: string;
  width?: number | null;
  height?: number | null;
  byteSize?: number | null;
}

/** A logical import source, stable across re-imports via `sourceKey`. */
export interface SourceInput {
  id?: string;
  sourceKey: string;
  type: SourceType;
  label: string;
  originPath?: string | null;
  rootPath?: string | null;
}

// ── Outputs ───────────────────────────────────────────────────────────────

/** A catalog item as returned by browse/search reads. */
export interface ItemRow {
  id: string;
  mediaType: MediaType;
  mimeType: string | null;
  contentHash: string | null;
  originalExt: string | null;
  fileSizeBytes: number | null;
  captureDate: string | null;
  captureDateSrc: CaptureDateSource | null;
  importDate: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  title: string | null;
  description: string | null;
  searchMeta: string | null;
  isFavourite: boolean;
  thumbStatus: string;
  createdAt: string;
  updatedAt: string;
  /** Connector this item came from (its first occurrence's source); null if no
   *  occurrence survives (AC-7). Derived at read time, not a column on `items`. */
  source: SourceType | null;
}

/** Opaque keyset position: the last row's (capture_date, id). */
export interface TimelineCursor {
  captureDate: string | null;
  id: string;
}

export interface TimelineQuery {
  limit: number;
  cursor?: TimelineCursor | null;
}

export interface TimelinePage {
  rows: ItemRow[];
  nextCursor: TimelineCursor | null;
}

export interface SearchQuery {
  query: string;
  limit: number;
  offset: number;
  /** Optional connector filter (AC-7): keep only items with an occurrence from
   *  this source. Omitted ⇒ every source (back-compatible). */
  source?: SourceType | null;
}

export interface SearchResult {
  rows: ItemRow[];
  total: number;
}

/**
 * A browsable collection's summary (#437): its opaque id, its display name, its
 * member count, and an optional cover item id (a hint only — no path). Excludes
 * `origin='dismissed'` tombstones — they carry no members and exist purely so
 * the suggestion derivation never re-proposes them (curation-repo).
 */
export interface CollectionSummary {
  id: string;
  name: string;
  itemCount: number;
  coverItemId: string | null;
}

/**
 * One `getCollection` read (#437): the collection's summary (or `null` when the
 * id names no browsable collection — unknown, or a dismissed tombstone), an
 * offset-paginated slice of its members, and the collection's total member
 * count so the caller can tell whether more remain.
 */
export interface CollectionMembersResult {
  collection: CollectionSummary | null;
  rows: ItemRow[];
  total: number;
}

/**
 * A transcribable media item (#157): an audio or video row the orchestrator may
 * hand to the off-thread worker, with its duration (when known) so the worker can
 * scale the per-item timeout (AC-20). Carries NO path — original resolution +
 * confinement happen separately through `resolveOriginal` (AC-14).
 */
export interface TranscribableItem {
  id: string;
  durationSec: number | null;
}

export interface CatalogRepo {
  insertItem(input: ItemInput): string;
  addOccurrence(input: OccurrenceInput): OccurrenceResult;
  addAsset(input: AssetInput): string;
  registerSource(input: SourceInput): string;
  queryTimeline(query: TimelineQuery): TimelinePage;
  search(query: SearchQuery): SearchResult;
  /**
   * Hydrate a set of item ids into full {@link ItemRow}s (M4-1b semantic-hit
   * hydration, ADR-0029), using the SAME projection and connector-source filter as
   * {@link search}. When `source` is non-null, only ids with an occurrence from
   * that source are returned — so a semantic hit the exact query would have
   * filtered out by source is never surfaced (AC-7). Unknown ids are ignored and an
   * empty list yields []. Order is unspecified: the caller re-ranks by similarity.
   */
  getItemsByIds(ids: readonly string[], source?: SourceType | null): ItemRow[];
  /** Enumerate every audio/video item (id + duration) for transcription (#157). */
  listTranscribableItems(): TranscribableItem[];
  /**
   * List every browsable collection (#437) — hand-made (`user`) or
   * accepted-suggested (`suggested`), each with its member count and an
   * optional cover item id. A `dismissed` tombstone collection is excluded — it
   * carries no members and exists purely so the derivation never re-proposes
   * it. Name-ordered (case-insensitive), then by id for a stable tiebreak.
   */
  listCollections(): CollectionSummary[];
  /**
   * Fetch ONE collection's summary plus an offset-paginated slice of its
   * members (#437), ordered by curated position (when set) then add order.
   * `collection` is `null` when the id names no browsable collection (unknown,
   * or a dismissed tombstone) — the caller surfaces that as a rejected invoke,
   * mirroring `getTranscript`'s unknown-id handling.
   */
  getCollection(query: { id: string; limit: number; offset: number }): CollectionMembersResult;
  /**
   * Set (or clear) one item's favourite flag by its opaque id (#434). A single
   * transactional `UPDATE ... RETURNING`, so the write and its read-back are
   * atomic. Returns the resolved `is_favourite` value as a boolean, or `null`
   * when the id names no item (an unknown id is never silently ignored).
   */
  setFavourite(input: { id: string; favourite: boolean }): boolean | null;
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Render a Date as a canonical ISO-8601 UTC instant (e.g.
 * `2019-06-14T13:45:30.000Z`). Every importer writes capture_date this way so
 * lexicographic DESC equals chronological DESC (ARCHITECTURE §3.2).
 */
export function toIsoUtc(date: Date): string {
  return date.toISOString();
}

/**
 * Order-preserving, de-duplicated union of whitespace-separated tokens. Used to
 * merge `search_meta` across sources on dedup so a deduped item stays findable
 * by every source's filenames/senders/subjects (AC-7).
 */
export function mergeTokens(existing: string | null, incoming: string | null): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of [existing, incoming]) {
    if (!source) continue;
    for (const token of source.split(/\s+/)) {
      if (token === '' || seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
  }
  return out.join(' ');
}

/**
 * Turn free user text into a safe FTS5 MATCH expression: each token becomes a
 * quoted prefix term (`"foo"*`), quotes are escaped, and tokens with no letter
 * or digit are dropped. Returns null when nothing tokenizable remains, so the
 * caller can short-circuit to an empty result instead of an FTS syntax error.
 */
export function toFtsMatchQuery(raw: string): string | null {
  const terms: string[] = [];
  for (const token of raw.split(/\s+/)) {
    if (token === '' || !/[\p{L}\p{N}]/u.test(token)) continue;
    terms.push(`"${token.replace(/"/g, '""')}"*`);
  }
  return terms.length === 0 ? null : terms.join(' ');
}

// ── Internal row mapping ────────────────────────────────────────────────────

const ITEM_COLUMNS = [
  'id',
  'media_type',
  'mime_type',
  'content_hash',
  'original_ext',
  'file_size_bytes',
  'capture_date',
  'capture_date_src',
  'import_date',
  'width',
  'height',
  'duration_sec',
  'title',
  'description',
  'search_meta',
  'is_favourite',
  'thumb_status',
  'created_at',
  'updated_at',
] as const;

const ITEM_SELECT = ITEM_COLUMNS.join(', ');
const ITEM_SELECT_I = ITEM_COLUMNS.map((column) => `i.${column}`).join(', ');

/**
 * A correlated subquery projecting each item's connector source — the `type` of
 * its first (earliest-imported) occurrence, deterministic via the `id` tiebreak.
 * An item with no surviving occurrence projects NULL. `itemRef` is a trusted
 * table alias literal (`items` or `i`), never user input. (AC-7)
 */
function sourceProjection(itemRef: string): string {
  return `(
    SELECT s.type
      FROM item_occurrences o
      JOIN sources s ON s.id = o.source_id
     WHERE o.item_id = ${itemRef}.id
     ORDER BY o.created_at, o.id
     LIMIT 1
  ) AS source`;
}

/**
 * A WHERE predicate that, when `@source` is bound non-null, keeps only items
 * having at least one occurrence from a source of that type; when `@source` is
 * NULL it is a no-op (every source passes), so the search stays back-compatible.
 */
function sourceFilter(itemRef: string): string {
  return `(@source IS NULL OR EXISTS (
    SELECT 1
      FROM item_occurrences o
      JOIN sources s ON s.id = o.source_id
     WHERE o.item_id = ${itemRef}.id AND s.type = @source
  ))`;
}

interface RawItemRow {
  id: string;
  media_type: MediaType;
  mime_type: string | null;
  content_hash: string | null;
  original_ext: string | null;
  file_size_bytes: number | null;
  capture_date: string | null;
  capture_date_src: CaptureDateSource | null;
  import_date: string;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  title: string | null;
  description: string | null;
  search_meta: string | null;
  is_favourite: number;
  thumb_status: string;
  created_at: string;
  updated_at: string;
  source: SourceType | null;
}

function mapItemRow(row: RawItemRow): ItemRow {
  return {
    id: row.id,
    mediaType: row.media_type,
    mimeType: row.mime_type,
    contentHash: row.content_hash,
    originalExt: row.original_ext,
    fileSizeBytes: row.file_size_bytes,
    captureDate: row.capture_date,
    captureDateSrc: row.capture_date_src,
    importDate: row.import_date,
    width: row.width,
    height: row.height,
    durationSec: row.duration_sec,
    title: row.title,
    description: row.description,
    searchMeta: row.search_meta,
    isFavourite: row.is_favourite === 1,
    thumbStatus: row.thumb_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: row.source,
  };
}

function requireRow<T>(row: T | undefined, operation: string): T {
  if (row === undefined) throw new Error(`catalog: ${operation} returned no row`);
  return row;
}

interface RawCollectionRow {
  id: string;
  name: string;
  cover_item_id: string | null;
  item_count: number;
}

function mapCollectionRow(row: RawCollectionRow): CollectionSummary {
  return { id: row.id, name: row.name, itemCount: row.item_count, coverItemId: row.cover_item_id };
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build the catalog data-access layer over an open, migrated database. The repo
 * is the single writer (ARCHITECTURE §4.1): every write goes through one
 * `INSERT ... ON CONFLICT ... RETURNING` so dedup and provenance stay atomic.
 */
export function createCatalogRepo(db: CatalogDatabase): CatalogRepo {
  // SQLite-side token merge for the dedup UPDATE path (keeps cross-source
  // search_meta on the row without a read-modify-write round-trip).
  db.function('merge_tokens', { deterministic: true }, (existing, incoming) =>
    mergeTokens(
      typeof existing === 'string' ? existing : null,
      typeof incoming === 'string' ? incoming : null,
    ),
  );

  const insertItemStmt = db.prepare(`
    INSERT INTO items (
      id, media_type, mime_type, content_hash, original_ext, file_size_bytes,
      capture_date, capture_date_src, width, height, duration_sec, orientation,
      camera_make, camera_model, gps_lat, gps_lon, gps_alt,
      title, description, search_meta
    ) VALUES (
      @id, @mediaType, @mimeType, @contentHash, @originalExt, @fileSizeBytes,
      @captureDate, @captureDateSrc, @width, @height, @durationSec, @orientation,
      @cameraMake, @cameraModel, @gpsLat, @gpsLon, @gpsAlt,
      @title, @description, @searchMeta
    )
    ON CONFLICT(content_hash) DO UPDATE SET
      mime_type        = COALESCE(items.mime_type, excluded.mime_type),
      original_ext     = COALESCE(items.original_ext, excluded.original_ext),
      file_size_bytes  = COALESCE(items.file_size_bytes, excluded.file_size_bytes),
      capture_date     = COALESCE(items.capture_date, excluded.capture_date),
      capture_date_src = COALESCE(items.capture_date_src, excluded.capture_date_src),
      width            = COALESCE(items.width, excluded.width),
      height           = COALESCE(items.height, excluded.height),
      duration_sec     = COALESCE(items.duration_sec, excluded.duration_sec),
      orientation      = COALESCE(items.orientation, excluded.orientation),
      camera_make      = COALESCE(items.camera_make, excluded.camera_make),
      camera_model     = COALESCE(items.camera_model, excluded.camera_model),
      gps_lat          = COALESCE(items.gps_lat, excluded.gps_lat),
      gps_lon          = COALESCE(items.gps_lon, excluded.gps_lon),
      gps_alt          = COALESCE(items.gps_alt, excluded.gps_alt),
      title            = COALESCE(items.title, excluded.title),
      description      = COALESCE(items.description, excluded.description),
      search_meta      = merge_tokens(items.search_meta, excluded.search_meta),
      updated_at       = datetime('now')
    RETURNING id
  `);

  const insertOccurrenceStmt = db.prepare(`
    INSERT INTO item_occurrences (
      id, item_id, source_id, source_ref, original_kind, original_path,
      author, occurred_at, source_meta
    ) VALUES (
      @id, @itemId, @sourceId, @sourceRef, @originalKind, @originalPath,
      @author, @occurredAt, @sourceMeta
    )
    ON CONFLICT(item_id, source_id, source_ref) DO NOTHING
    RETURNING id
  `);
  const selectOccurrenceStmt = db.prepare(`
    SELECT id FROM item_occurrences
    WHERE item_id = @itemId AND source_id = @sourceId AND source_ref = @sourceRef
  `);

  const insertAssetStmt = db.prepare(`
    INSERT INTO item_assets (id, item_id, kind, path, width, height, byte_size)
    VALUES (@id, @itemId, @kind, @path, @width, @height, @byteSize)
    ON CONFLICT(item_id, kind) DO UPDATE SET
      path      = excluded.path,
      width     = COALESCE(excluded.width, item_assets.width),
      height    = COALESCE(excluded.height, item_assets.height),
      byte_size = COALESCE(excluded.byte_size, item_assets.byte_size)
    RETURNING id
  `);

  const insertSourceStmt = db.prepare(`
    INSERT INTO sources (id, source_key, type, label, origin_path, root_path)
    VALUES (@id, @sourceKey, @type, @label, @originPath, @rootPath)
    ON CONFLICT(source_key) DO UPDATE SET
      label       = excluded.label,
      origin_path = COALESCE(excluded.origin_path, sources.origin_path),
      root_path   = COALESCE(excluded.root_path, sources.root_path),
      imported_at = datetime('now')
    RETURNING id
  `);

  const timelineFirstStmt = db.prepare(`
    SELECT ${ITEM_SELECT}, ${sourceProjection('items')} FROM items
    ORDER BY capture_date DESC NULLS LAST, id DESC
    LIMIT @limit
  `);
  // Dated cursor: earlier dates, ties broken by id, then the undated tail.
  const timelineDatedStmt = db.prepare(`
    SELECT ${ITEM_SELECT}, ${sourceProjection('items')} FROM items
    WHERE capture_date < @cd
       OR (capture_date = @cd AND id < @id)
       OR capture_date IS NULL
    ORDER BY capture_date DESC NULLS LAST, id DESC
    LIMIT @limit
  `);
  // Null-tail cursor: paging within the undated rows, ordered by id DESC.
  const timelineNullTailStmt = db.prepare(`
    SELECT ${ITEM_SELECT}, ${sourceProjection('items')} FROM items
    WHERE capture_date IS NULL AND id < @id
    ORDER BY id DESC
    LIMIT @limit
  `);

  const searchStmt = db.prepare(`
    SELECT ${ITEM_SELECT_I}, ${sourceProjection('i')} FROM items_fts
    JOIN items i ON i.rowid = items_fts.rowid
    WHERE items_fts MATCH @match
      AND ${sourceFilter('i')}
    ORDER BY rank
    LIMIT @limit OFFSET @offset
  `);
  const searchCountStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM items_fts
    JOIN items i ON i.rowid = items_fts.rowid
    WHERE items_fts MATCH @match
      AND ${sourceFilter('i')}
  `);
  // Hydrate a JSON array of ids back into full item rows for the semantic-hit
  // merge (ADR-0029), reusing the exact search's projection + source filter so a
  // hit is never surfaced past the connector filter (AC-7). `json_each` keeps this
  // a single static prepared statement over a variable-length id list.
  const itemsByIdsStmt = db.prepare(`
    SELECT ${ITEM_SELECT_I}, ${sourceProjection('i')} FROM items i
    WHERE i.id IN (SELECT value FROM json_each(@ids))
      AND ${sourceFilter('i')}
  `);
  // Audio + video only (the transcribable media types), newest-agnostic stable id
  // order so a re-run dispatches the same sequence (#157).
  const listTranscribableStmt = db.prepare(`
    SELECT id, duration_sec FROM items
    WHERE media_type IN ('audio', 'video')
    ORDER BY id
  `);
  // One transactional write + read-back (#434): flips is_favourite for the named
  // id and returns the resolved value in the SAME statement, so a concurrent
  // reader can never observe a torn write. Touches updated_at like every other
  // items write (insertItem's ON CONFLICT branch above).
  const setFavouriteStmt = db.prepare(`
    UPDATE items SET is_favourite = @favourite, updated_at = datetime('now')
    WHERE id = @id
    RETURNING is_favourite
  `);

  // ── Collections browser view (#437) ────────────────────────────────────────
  // A `dismissed` tombstone collection is excluded from every read below — it
  // carries no members and exists purely so the suggestion derivation never
  // re-proposes it (curation-repo). The member count is a correlated subquery
  // rather than a JOIN + GROUP BY so a member-less collection still projects a
  // row (COUNT(*) over zero joined rows would otherwise vanish it).
  //
  // Both statements below reference `collections.origin`, a column migration
  // 005 adds (ARCHITECTURE §4.2) — every OTHER statement in this factory
  // references only the migration-001 schema, so this is the only pair prepared
  // LAZILY (on first call, not at factory construction) rather than eagerly up
  // front: eager preparation would throw immediately when a repo is built
  // against an intentionally partial-migration snapshot, which the AC-29
  // migration-boundary tests do (db-migrate.test.ts) even though production
  // always opens a fully-migrated catalog before constructing a repo.
  let listCollectionsStmt: ReturnType<typeof db.prepare> | undefined;
  function requireListCollectionsStmt(): ReturnType<typeof db.prepare> {
    return (listCollectionsStmt ??= db.prepare(`
      SELECT c.id, c.name, c.cover_item_id,
        (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS item_count
      FROM collections c
      WHERE c.origin != 'dismissed'
      ORDER BY c.name COLLATE NOCASE ASC, c.id ASC
    `));
  }
  let getCollectionSummaryStmt: ReturnType<typeof db.prepare> | undefined;
  function requireGetCollectionSummaryStmt(): ReturnType<typeof db.prepare> {
    return (getCollectionSummaryStmt ??= db.prepare(`
      SELECT c.id, c.name, c.cover_item_id,
        (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS item_count
      FROM collections c
      WHERE c.id = @id AND c.origin != 'dismissed'
    `));
  }
  // Curated `position` first (NULLS LAST — an un-curated member sorts after any
  // explicitly ordered one), then add order, then id for a fully stable tiebreak.
  const getCollectionMembersStmt = db.prepare(`
    SELECT ${ITEM_SELECT_I}, ${sourceProjection('i')} FROM collection_items ci
    JOIN items i ON i.id = ci.item_id
    WHERE ci.collection_id = @id
    ORDER BY ci.position ASC NULLS LAST, ci.added_at ASC, i.id ASC
    LIMIT @limit OFFSET @offset
  `);

  return {
    insertItem(input) {
      const row = insertItemStmt.get<{ id: string }>({
        id: input.id ?? randomUUID(),
        mediaType: input.mediaType,
        mimeType: input.mimeType ?? null,
        contentHash: input.contentHash ?? null,
        originalExt: input.originalExt ?? null,
        fileSizeBytes: input.fileSizeBytes ?? null,
        captureDate: input.captureDate ?? null,
        captureDateSrc: input.captureDateSrc ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
        durationSec: input.durationSec ?? null,
        orientation: input.orientation ?? null,
        cameraMake: input.cameraMake ?? null,
        cameraModel: input.cameraModel ?? null,
        gpsLat: input.gpsLat ?? null,
        gpsLon: input.gpsLon ?? null,
        gpsAlt: input.gpsAlt ?? null,
        title: input.title ?? null,
        description: input.description ?? null,
        searchMeta: input.searchMeta ?? null,
      });
      return requireRow(row, 'insertItem').id;
    },

    addOccurrence(input) {
      const params = {
        id: input.id ?? randomUUID(),
        itemId: input.itemId,
        sourceId: input.sourceId,
        sourceRef: input.sourceRef,
        originalKind: input.originalKind ?? 'none',
        originalPath: input.originalPath ?? null,
        author: input.author ?? null,
        occurredAt: input.occurredAt ?? null,
        sourceMeta: input.sourceMeta ?? null,
      };
      const inserted = insertOccurrenceStmt.get<{ id: string }>(params);
      if (inserted) return { id: inserted.id, inserted: true };
      const existing = requireRow(
        selectOccurrenceStmt.get<{ id: string }>({
          itemId: params.itemId,
          sourceId: params.sourceId,
          sourceRef: params.sourceRef,
        }),
        'addOccurrence',
      );
      return { id: existing.id, inserted: false };
    },

    addAsset(input) {
      const row = insertAssetStmt.get<{ id: string }>({
        id: input.id ?? randomUUID(),
        itemId: input.itemId,
        kind: input.kind,
        path: input.path,
        width: input.width ?? null,
        height: input.height ?? null,
        byteSize: input.byteSize ?? null,
      });
      return requireRow(row, 'addAsset').id;
    },

    registerSource(input) {
      const row = insertSourceStmt.get<{ id: string }>({
        id: input.id ?? randomUUID(),
        sourceKey: input.sourceKey,
        type: input.type,
        label: input.label,
        originPath: input.originPath ?? null,
        rootPath: input.rootPath ?? null,
      });
      return requireRow(row, 'registerSource').id;
    },

    queryTimeline({ limit, cursor }) {
      let raws: RawItemRow[];
      if (!cursor) {
        raws = timelineFirstStmt.all<RawItemRow>({ limit });
      } else if (cursor.captureDate !== null) {
        raws = timelineDatedStmt.all<RawItemRow>({ cd: cursor.captureDate, id: cursor.id, limit });
      } else {
        raws = timelineNullTailStmt.all<RawItemRow>({ id: cursor.id, limit });
      }
      const rows = raws.map(mapItemRow);
      const last = rows.at(-1);
      const nextCursor =
        last && rows.length === limit ? { captureDate: last.captureDate, id: last.id } : null;
      return { rows, nextCursor };
    },

    search({ query, limit, offset, source }) {
      const match = toFtsMatchQuery(query);
      if (match === null) return { rows: [], total: 0 };
      const sourceParam = source ?? null;
      const total = Number(
        searchCountStmt.get<{ n: number }>({ match, source: sourceParam })?.n ?? 0,
      );
      const raws = searchStmt.all<RawItemRow>({ match, limit, offset, source: sourceParam });
      return { rows: raws.map(mapItemRow), total };
    },

    getItemsByIds(ids, source) {
      if (ids.length === 0) return [];
      const raws = itemsByIdsStmt.all<RawItemRow>({
        ids: JSON.stringify([...ids]),
        source: source ?? null,
      });
      return raws.map(mapItemRow);
    },

    listTranscribableItems() {
      const rows = listTranscribableStmt.all<{ id: string; duration_sec: number | null }>();
      return rows.map((row) => ({ id: row.id, durationSec: row.duration_sec }));
    },

    setFavourite(input) {
      const row = setFavouriteStmt.get<{ is_favourite: number }>({
        id: input.id,
        favourite: input.favourite ? 1 : 0,
      });
      return row === undefined ? null : row.is_favourite === 1;
    },

    listCollections() {
      return requireListCollectionsStmt().all<RawCollectionRow>().map(mapCollectionRow);
    },

    getCollection({ id, limit, offset }) {
      const summary = requireGetCollectionSummaryStmt().get<RawCollectionRow>({ id });
      if (summary === undefined) {
        return { collection: null, rows: [], total: 0 };
      }
      const raws = getCollectionMembersStmt.all<RawItemRow>({ id, limit, offset });
      return { collection: mapCollectionRow(summary), rows: raws.map(mapItemRow), total: summary.item_count };
    },
  };
}
