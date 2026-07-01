import { cosineSimilarity } from '../search/semantic';
import type { CatalogDatabase } from './connection';

// Embedding persistence for M4 smart search (ADR-0029 Decisions 1 & 4, milestone
// M4-1). A vector is a DERIVED rendition of an EXISTING item — like a thumbnail or
// transcript — so it ATTACHES to that item (FK ON DELETE CASCADE) and never
// creates one. This module is the storage + brute-force cosine scan half of the
// engine; the pure ranking math lives in ../search/semantic. Three jobs:
//   1. store/replace an item's float32 vector as a little-endian BLOB, keyed by
//      (item_id, model_id) so re-embedding REPLACES and provenance stays explicit;
//   2. drive the per-item `embed_status` drain (pending → done | error | skipped),
//      analogous to `thumb_status`, so the existing catalog is back-filled
//      off-thread — `upsertEmbedding` flips the flag to `done`;
//   3. answer a semantic query by brute-force cosine over the stored vectors of
//      ONE model (guarded by model_id + dim), the KNN feed the FTS-merge consumes.
// This slice embeds NOTHING (no model, no dependency): query-text → vector and the
// live-search wiring land in M4-1b. The engine here is exercised by unit tests only.

/** The per-item embedding drain states (mirrors the items.embed_status CHECK). */
export const EMBED_STATUSES = ['pending', 'done', 'error', 'skipped'] as const;
export type EmbedStatus = (typeof EMBED_STATUSES)[number];

/** A stored embedding as loaded back from storage. */
export interface EmbeddingRecord {
  itemId: string;
  modelId: string;
  /** Vector length; equals the decoded Float32Array length. */
  dim: number;
  vector: Float32Array;
  /** Canonical ISO-8601 UTC instant the vector was stored. */
  createdAt: string;
}

/** An item awaiting embedding (embed_status = 'pending'), with the text to embed. */
export interface PendingEmbeddingItem {
  id: string;
  mediaType: string;
  /** Message body / caption fed to the text embedder (M4-1b). */
  description: string | null;
  /** Denormalized FTS feed (filenames, senders, transcripts) — also embeddable text. */
  searchMeta: string | null;
}

/** Constraints on a semantic scan. `modelId` guards vector comparability (ADR-0029). */
export interface SemanticSearchFilters {
  /** Only vectors produced by THIS model are compared (never mix model spaces). */
  modelId: string;
}

/** One semantic hit: the item's id and its cosine similarity to the query, in [-1, 1]. */
export interface SemanticSearchHit {
  itemId: string;
  score: number;
}

/** The embedding data-access layer over an open, migrated catalog database. */
export interface EmbeddingsRepo {
  /**
   * Store (or REPLACE) the item's vector for `modelId` and flip its
   * `embed_status` to `done`, in one transaction. The vector is written as a
   * little-endian float32 BLOB with `dim = vector.length`. Throws if the item
   * does not exist (an embedding never creates an item — dedup-with-provenance).
   */
  upsertEmbedding(itemId: string, modelId: string, vector: Float32Array): void;
  /** Load an item's vector for `modelId`, or null when none has been stored. */
  getEmbedding(itemId: string, modelId: string): EmbeddingRecord | null;
  /** The next items awaiting embedding (embed_status = 'pending'), in stable id order. */
  listPendingEmbeddings(limit: number): PendingEmbeddingItem[];
  /**
   * Brute-force cosine KNN over the stored vectors of ONE model (ADR-0029): rank
   * every same-dimension vector for `filters.modelId` by cosine similarity to
   * `queryVector` (desc, id-asc tiebreak) and return the top `limit`. Returns []
   * for a non-positive `limit`. Vectors of a different dimension are skipped, so
   * the query dimension need not be known ahead of time.
   */
  semanticSearch(
    queryVector: Float32Array,
    limit: number,
    filters: SemanticSearchFilters,
  ): SemanticSearchHit[];
}

// ── Float32 ⇄ little-endian BLOB codec ──────────────────────────────────────
// Explicit per-element writeFloatLE/readFloatLE (rather than a Float32Array view
// over Buffer.buffer) is robust to Node's shared Buffer pool byte-offset/alignment
// AND pins little-endian, so a catalog is portable across CPU endianness.

/**
 * Guard the persistence boundary before a vector is serialized to a BLOB: a
 * stored vector must be non-empty and every element finite. A NaN/±Infinity
 * element or an empty vector signals a broken upstream embed — reject it here so
 * it can never be encoded, persisted, or flip an item's `embed_status` to `done`
 * (ADR-0029; complements the migration-003 `dim > 0 AND length(vector) = dim*4`
 * CHECK, which cannot see the float values themselves).
 */
function assertPersistableVector(vector: Float32Array): void {
  if (vector.length === 0) {
    throw new Error('encodeVector: refusing to encode an empty vector (dim must be > 0)');
  }
  for (let i = 0; i < vector.length; i += 1) {
    if (!Number.isFinite(vector[i])) {
      throw new Error(
        `encodeVector: refusing to encode a non-finite vector (element ${i} = ${vector[i]})`,
      );
    }
  }
}

/** Encode a Float32Array as a fresh little-endian float32 Buffer (dim*4 bytes). */
export function encodeVector(vector: Float32Array): Buffer {
  assertPersistableVector(vector);
  const buffer = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i += 1) buffer.writeFloatLE(vector[i], i * 4);
  return buffer;
}

/** Decode a little-endian float32 Buffer back into a Float32Array. */
export function decodeVector(blob: Buffer): Float32Array {
  const vector = new Float32Array(Math.floor(blob.byteLength / 4));
  for (let i = 0; i < vector.length; i += 1) vector[i] = blob.readFloatLE(i * 4);
  return vector;
}

interface RawEmbeddingRow {
  item_id: string;
  model_id: string;
  dim: number;
  vector: Buffer;
  created_at: string;
}
interface RawPendingRow {
  id: string;
  media_type: string;
  description: string | null;
  search_meta: string | null;
}
interface RawScanRow {
  item_id: string;
  vector: Buffer;
}

/**
 * Build the embedding data-access layer over an open, migrated database. Mirrors
 * the catalog/transcript single-writer pattern: each operation is one prepared
 * statement, and the upsert runs in a transaction so the vector row and the
 * `embed_status` flip commit (or roll back) together.
 */
export function createEmbeddingsRepo(db: CatalogDatabase): EmbeddingsRepo {
  const upsertVectorStmt = db.prepare(`
    INSERT INTO item_embeddings (item_id, model_id, dim, vector)
    VALUES (@itemId, @modelId, @dim, @vector)
    ON CONFLICT(item_id, model_id) DO UPDATE SET
      dim        = excluded.dim,
      vector     = excluded.vector,
      created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);
  const markEmbeddedStmt = db.prepare(`
    UPDATE items SET embed_status = 'done', updated_at = datetime('now') WHERE id = @itemId
  `);
  const selectEmbeddingStmt = db.prepare(`
    SELECT item_id, model_id, dim, vector, created_at
      FROM item_embeddings
     WHERE item_id = @itemId AND model_id = @modelId
  `);
  const listPendingStmt = db.prepare(`
    SELECT id, media_type, description, search_meta
      FROM items
     WHERE embed_status = 'pending'
     ORDER BY id
     LIMIT @limit
  `);
  const scanModelStmt = db.prepare(`
    SELECT item_id, vector
      FROM item_embeddings
     WHERE model_id = @modelId AND dim = @dim
  `);

  const upsert = db.transaction((itemId: string, modelId: string, vector: Float32Array) => {
    // FK REFERENCES items(id): the INSERT throws if the item does not exist, so a
    // vector can never outlive (or precede) its item.
    upsertVectorStmt.run({ itemId, modelId, dim: vector.length, vector: encodeVector(vector) });
    markEmbeddedStmt.run({ itemId });
  });

  return {
    upsertEmbedding(itemId, modelId, vector) {
      upsert(itemId, modelId, vector);
    },

    getEmbedding(itemId, modelId) {
      const row = selectEmbeddingStmt.get<RawEmbeddingRow>({ itemId, modelId });
      if (row === undefined) return null;
      return {
        itemId: row.item_id,
        modelId: row.model_id,
        dim: row.dim,
        vector: decodeVector(row.vector),
        createdAt: row.created_at,
      };
    },

    listPendingEmbeddings(limit) {
      return listPendingStmt.all<RawPendingRow>({ limit }).map((row) => ({
        id: row.id,
        mediaType: row.media_type,
        description: row.description,
        searchMeta: row.search_meta,
      }));
    },

    semanticSearch(queryVector, limit, filters) {
      if (limit <= 0) return [];
      // dim guard: only same-length vectors are scanned, so cosineSimilarity is
      // always well-defined (never throws) for the guarded model's rows.
      const rows = scanModelStmt.all<RawScanRow>({
        modelId: filters.modelId,
        dim: queryVector.length,
      });
      const hits = rows.map((row) => ({
        itemId: row.item_id,
        score: cosineSimilarity(queryVector, decodeVector(row.vector)),
      }));
      hits.sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (left.itemId === right.itemId) return 0;
        return left.itemId < right.itemId ? -1 : 1;
      });
      return hits.slice(0, limit);
    },
  };
}
