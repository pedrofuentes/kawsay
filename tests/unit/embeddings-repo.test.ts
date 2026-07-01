import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { type Database as Db } from 'better-sqlite3';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';
import {
  createEmbeddingsRepo,
  decodeVector,
  encodeVector,
  EMBED_STATUSES,
  type EmbeddingsRepo,
} from '../../electron/main/db/embeddings-repo';

const MODEL = 'test-embed-v1';
const vec = (...values: number[]): Float32Array => Float32Array.from(values);

function freshCatalog(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function count(db: Db, sql: string): number {
  return Number((db.prepare(sql).get<{ n: number }>() as { n: number }).n);
}

function statusOf(db: Db, id: string): string {
  return (
    db.prepare('SELECT embed_status FROM items WHERE id = ?').get<{ embed_status: string }>(id)
      ?.embed_status ?? ''
  );
}

describe('encodeVector / decodeVector (float32 little-endian BLOB round-trip)', () => {
  it('round-trips a vector through a Buffer with float32 fidelity', () => {
    const original = vec(0, 1, -1, 0.5, -0.25, 1234.5);
    expect(Array.from(decodeVector(encodeVector(original)))).toEqual(Array.from(original));
  });

  it('encodes 4 little-endian bytes per element (a dim*4-byte BLOB)', () => {
    const buffer = encodeVector(vec(1, 2, 3));
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.byteLength).toBe(12);
    expect(buffer.readFloatLE(0)).toBeCloseTo(1);
    expect(buffer.readFloatLE(4)).toBeCloseTo(2);
    expect(buffer.readFloatLE(8)).toBeCloseTo(3);
  });

  it('stores values at float32 precision (float64 inputs are rounded on the way in)', () => {
    // 0.1 is not representable in float32; the stored/decoded value is Math.fround(0.1).
    const decoded = decodeVector(encodeVector(vec(0.1)));
    expect(decoded[0]).toBe(Math.fround(0.1));
  });

  it('throws for a non-finite element so a NaN/±Infinity vector never reaches a BLOB', () => {
    expect(() => encodeVector(vec(1, NaN, 3))).toThrow();
    expect(() => encodeVector(vec(1, Infinity))).toThrow();
    expect(() => encodeVector(vec(-Infinity, 0))).toThrow();
  });

  it('throws for an empty vector (a stored vector must have dim > 0)', () => {
    expect(() => encodeVector(vec())).toThrow();
  });
});

describe('EmbeddingsRepo (item_embeddings + embed_status drain, ADR-0029 · M4-1)', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: EmbeddingsRepo;

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createEmbeddingsRepo(db);
  });
  afterEach(() => db.close());

  function seedItem(id: string): string {
    return catalog.insertItem({ id, mediaType: 'message', description: `item ${id}` });
  }

  it('exposes the drain vocabulary matching the items.embed_status CHECK', () => {
    expect(EMBED_STATUSES).toEqual(['pending', 'done', 'error', 'skipped']);
  });

  it('round-trips a stored embedding (Float32 fidelity) and flips the drain to done', () => {
    seedItem('i1');
    expect(statusOf(db, 'i1')).toBe('pending');

    repo.upsertEmbedding('i1', MODEL, vec(0.1, 0.2, 0.3));

    const record = repo.getEmbedding('i1', MODEL);
    expect(record).not.toBeNull();
    expect(record?.itemId).toBe('i1');
    expect(record?.modelId).toBe(MODEL);
    expect(record?.dim).toBe(3);
    expect(Array.from(record?.vector ?? [])).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
    expect(record?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // upsert flips the per-item drain flag pending → done.
    expect(statusOf(db, 'i1')).toBe('done');
  });

  it('returns null for an item/model with no stored embedding', () => {
    seedItem('i1');
    expect(repo.getEmbedding('i1', MODEL)).toBeNull();
    repo.upsertEmbedding('i1', MODEL, vec(1, 0));
    // A different model has no vector for this item.
    expect(repo.getEmbedding('i1', 'other-model')).toBeNull();
  });

  it('replaces the vector on re-embed (UNIQUE item_id, model_id) — never duplicates', () => {
    seedItem('i1');
    repo.upsertEmbedding('i1', MODEL, vec(1, 0, 0));
    repo.upsertEmbedding('i1', MODEL, vec(0, 1, 0));
    expect(Array.from(repo.getEmbedding('i1', MODEL)?.vector ?? [])).toEqual([0, 1, 0]);
    expect(count(db, "SELECT COUNT(*) n FROM item_embeddings WHERE item_id = 'i1'")).toBe(1);
  });

  it('cascades the embedding row when its item is deleted (a removable rendition, AC-14)', () => {
    seedItem('i1');
    repo.upsertEmbedding('i1', MODEL, vec(1, 2, 3));
    db.prepare("DELETE FROM items WHERE id = 'i1'").run();
    expect(count(db, 'SELECT COUNT(*) n FROM item_embeddings')).toBe(0);
  });

  describe('listPendingEmbeddings (backfill drain)', () => {
    it('lists pending items in stable id order and excludes embedded ones', () => {
      for (const id of ['c', 'a', 'b']) seedItem(id);
      expect(repo.listPendingEmbeddings(10).map((r) => r.id)).toEqual(['a', 'b', 'c']);
      repo.upsertEmbedding('a', MODEL, vec(1, 0));
      expect(repo.listPendingEmbeddings(10).map((r) => r.id)).toEqual(['b', 'c']);
    });

    it('honours the limit', () => {
      for (const id of ['a', 'b', 'c']) seedItem(id);
      expect(repo.listPendingEmbeddings(2).map((r) => r.id)).toEqual(['a', 'b']);
    });
  });

  describe('semanticSearch (brute-force cosine, guarded by model_id)', () => {
    beforeEach(() => {
      for (const id of ['near', 'mid', 'far']) seedItem(id);
      repo.upsertEmbedding('near', MODEL, vec(1, 0));
      repo.upsertEmbedding('mid', MODEL, vec(1, 1));
      repo.upsertEmbedding('far', MODEL, vec(0, 1));
    });

    it('ranks stored vectors by cosine similarity to the query (desc)', () => {
      const hits = repo.semanticSearch(vec(1, 0), 10, { modelId: MODEL });
      expect(hits.map((h) => h.itemId)).toEqual(['near', 'mid', 'far']);
      expect(hits[0]?.score).toBeCloseTo(1, 6);
      expect(hits[2]?.score).toBeCloseTo(0, 6);
    });

    it('honours the limit (top-k)', () => {
      const hits = repo.semanticSearch(vec(1, 0), 2, { modelId: MODEL });
      expect(hits.map((h) => h.itemId)).toEqual(['near', 'mid']);
    });

    it('returns [] for a non-positive limit', () => {
      expect(repo.semanticSearch(vec(1, 0), 0, { modelId: MODEL })).toEqual([]);
    });

    it('only compares vectors from the guarded model_id', () => {
      seedItem('other');
      repo.upsertEmbedding('other', 'other-model', vec(1, 0));
      const hits = repo.semanticSearch(vec(1, 0), 10, { modelId: 'other-model' });
      expect(hits.map((h) => h.itemId)).toEqual(['other']);
    });

    it('excludes stored vectors whose dim differs from the query (guards cosine)', () => {
      seedItem('threeDim');
      repo.upsertEmbedding('threeDim', MODEL, vec(1, 0, 0));
      const hits = repo.semanticSearch(vec(1, 0), 10, { modelId: MODEL });
      expect(hits.map((h) => h.itemId)).not.toContain('threeDim');
    });

    it('returns an empty list when no vectors exist for the model', () => {
      expect(repo.semanticSearch(vec(1, 0), 10, { modelId: 'no-such-model' })).toEqual([]);
    });
  });

  describe('rejects invalid vectors at the upsert boundary (never persists, never flips the drain)', () => {
    it('rejects a non-finite vector: no row is written and embed_status stays pending', () => {
      seedItem('i1');
      expect(() => repo.upsertEmbedding('i1', MODEL, vec(1, NaN, 3))).toThrow();
      expect(repo.getEmbedding('i1', MODEL)).toBeNull();
      expect(count(db, "SELECT COUNT(*) n FROM item_embeddings WHERE item_id = 'i1'")).toBe(0);
      // A rejected embed must NOT advance the drain — the item is still pending.
      expect(statusOf(db, 'i1')).toBe('pending');
    });

    it('rejects an empty vector: no row is written and embed_status stays pending', () => {
      seedItem('i1');
      expect(() => repo.upsertEmbedding('i1', MODEL, vec())).toThrow();
      expect(count(db, "SELECT COUNT(*) n FROM item_embeddings WHERE item_id = 'i1'")).toBe(0);
      expect(statusOf(db, 'i1')).toBe('pending');
    });
  });
});
