import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { type Database as Db } from 'better-sqlite3';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';
import {
  ASSIGNMENT_SIGNALS,
  ASSIGNMENT_SOURCES,
  ASSIGNMENT_STATES,
  CATEGORY_KINDS,
  createCategoriesRepo,
  type CategoriesRepo,
  type CategoryKind,
} from '../../electron/main/categorize/categories-repo';

// A real in-memory better-sqlite3 catalog with every migration applied (NO db
// mocking) — the same fixture shape embeddings-repo.test.ts uses, so the repo is
// exercised against the live migration-005 schema (CHECKs, FKs, partial-UNIQUE).
function freshCatalog(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); // enforce the ON DELETE CASCADE assertions
  runMigrations(db);
  return db;
}

function count(db: Db, sql: string): number {
  return Number((db.prepare(sql).get<{ n: number }>() as { n: number }).n);
}

/** The stored shape of an item_categories row (asserted directly to prove a row is untouched). */
interface StoredAssignment {
  item_id: string;
  category_id: string;
  source: string;
  state: string;
  signal: string | null;
  confidence: number | null;
  explanation: string | null;
}

function storedRow(
  db: Db,
  itemId: string,
  categoryId: string,
  source: string,
): StoredAssignment | undefined {
  return db
    .prepare(
      `SELECT item_id, category_id, source, state, signal, confidence, explanation
         FROM item_categories
        WHERE item_id = ? AND category_id = ? AND source = ?`,
    )
    .get<StoredAssignment>(itemId, categoryId, source);
}

describe('categories-repo — exported vocabularies match the migration-005 CHECKs', () => {
  it('mirrors the categories.kind / item_categories source|state|signal CHECK sets', () => {
    expect(CATEGORY_KINDS).toEqual(['person', 'place', 'theme']);
    expect(ASSIGNMENT_SOURCES).toEqual(['auto', 'user']);
    expect(ASSIGNMENT_STATES).toEqual(['assigned', 'removed']);
    expect(ASSIGNMENT_SIGNALS).toEqual(['gps', 'theme-cluster', 'face-cluster', 'user']);
  });
});

describe('createCategoriesRepo — idempotent category upsert by source_key', () => {
  let db: Db;
  let repo: CategoriesRepo;

  beforeEach(() => {
    db = freshCatalog();
    repo = createCategoriesRepo(db);
  });
  afterEach(() => db.close());

  it('inserts a new category and reads it back with its full provenance', () => {
    const id = repo.upsertCategory({
      kind: 'place',
      name: 'Cusco, Perú',
      sourceKey: 'place:3931198',
    });

    const row = repo.getCategory(id);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(id);
    expect(row?.kind).toBe('place');
    expect(row?.name).toBe('Cusco, Perú');
    expect(row?.sourceKey).toBe('place:3931198');
    expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('re-clustering the SAME source_key returns the SAME row and never duplicates (upsert)', () => {
    const first = repo.upsertCategory({ kind: 'place', name: 'Cusco', sourceKey: 'place:3931198' });
    // A later re-cluster re-derives a refined label for the same stable signal.
    const second = repo.upsertCategory({
      kind: 'place',
      name: 'Cusco, Perú',
      sourceKey: 'place:3931198',
    });

    expect(second).toBe(first); // same category id — the partial-UNIQUE index collapses it
    expect(count(db, "SELECT COUNT(*) n FROM categories WHERE source_key = 'place:3931198'")).toBe(
      1,
    );
    // The refreshed auto label wins on re-cluster.
    expect(repo.getCategory(first)?.name).toBe('Cusco, Perú');
    expect(repo.getCategoryBySourceKey('place:3931198')?.id).toBe(first);
  });

  it('NULL source_key user categories are EXEMPT from the collapse — each upsert is a fresh row', () => {
    const a = repo.upsertCategory({ kind: 'person', name: 'Mom', sourceKey: null });
    const b = repo.upsertCategory({ kind: 'person', name: 'Mom', sourceKey: null });
    const c = repo.upsertCategory({ kind: 'theme', name: 'Trip' }); // sourceKey omitted → NULL

    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
    expect(count(db, 'SELECT COUNT(*) n FROM categories WHERE source_key IS NULL')).toBe(3);
    expect(repo.getCategory(a)?.sourceKey).toBeNull();
  });

  it('distinct source_keys (place vs theme) never cross-collapse', () => {
    const place = repo.upsertCategory({ kind: 'place', name: 'Beach', sourceKey: 'place:99' });
    const theme = repo.upsertCategory({
      kind: 'theme',
      name: 'Beach',
      sourceKey: 'theme:deadbeef',
    });

    expect(place).not.toBe(theme);
    expect(count(db, 'SELECT COUNT(*) n FROM categories')).toBe(2);
    expect(repo.getCategoryBySourceKey('theme:deadbeef')?.kind).toBe('theme');
  });

  it('getCategory / getCategoryBySourceKey return null for an unknown id / key', () => {
    expect(repo.getCategory('nope')).toBeNull();
    expect(repo.getCategoryBySourceKey('place:missing')).toBeNull();
  });

  it('rejects a kind outside the CHECK vocabulary', () => {
    expect(() =>
      repo.upsertCategory({ kind: 'landmark' as CategoryKind, name: 'x', sourceKey: 'place:1' }),
    ).toThrow();
    expect(count(db, 'SELECT COUNT(*) n FROM categories')).toBe(0);
  });
});

describe('createCategoriesRepo — item_categories writes + effective-assignment resolver', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: CategoriesRepo;
  let categoryId: string;

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createCategoriesRepo(db);
    catalog.insertItem({ id: 'i1', mediaType: 'message', description: 'photo i1' });
    categoryId = repo.upsertCategory({
      kind: 'place',
      name: 'Cusco, Perú',
      sourceKey: 'place:3931198',
    });
  });
  afterEach(() => db.close());

  it('resolves to null (no assignment) when the item is in no category', () => {
    expect(repo.resolveAssignment('i1', categoryId)).toBeNull();
  });

  it('writes an AUTO assignment and resolves it with full provenance (auto-only)', () => {
    repo.assignAuto({
      itemId: 'i1',
      categoryId,
      signal: 'gps',
      confidence: 0.92,
      explanation: 'Near Cusco, Perú (photo GPS)',
    });

    expect(repo.resolveAssignment('i1', categoryId)).toEqual({
      itemId: 'i1',
      categoryId,
      source: 'auto',
      state: 'assigned',
      signal: 'gps',
      confidence: 0.92,
      explanation: 'Near Cusco, Perú (photo GPS)',
    });
  });

  it('accepts a null confidence/explanation auto assignment (theme signal)', () => {
    repo.assignAuto({ itemId: 'i1', categoryId, signal: 'theme-cluster' });

    const eff = repo.resolveAssignment('i1', categoryId);
    expect(eff?.source).toBe('auto');
    expect(eff?.signal).toBe('theme-cluster');
    expect(eff?.confidence).toBeNull();
    expect(eff?.explanation).toBeNull();
  });

  it('an auto RE-WRITE upserts the same (item,category,auto) row — refreshes, never duplicates', () => {
    repo.assignAuto({ itemId: 'i1', categoryId, signal: 'gps', confidence: 0.5 });
    repo.assignAuto({ itemId: 'i1', categoryId, signal: 'gps', confidence: 0.8 });

    expect(
      count(db, "SELECT COUNT(*) n FROM item_categories WHERE item_id='i1' AND source='auto'"),
    ).toBe(1);
    expect(repo.resolveAssignment('i1', categoryId)?.confidence).toBe(0.8);
  });

  it('accepts confidence boundary values 0 and 1 but rejects values outside [0,1]', () => {
    expect(() =>
      repo.assignAuto({ itemId: 'i1', categoryId, signal: 'gps', confidence: 0 }),
    ).not.toThrow();
    expect(() =>
      repo.assignAuto({ itemId: 'i1', categoryId, signal: 'gps', confidence: 1 }),
    ).not.toThrow();
    expect(() =>
      repo.assignAuto({ itemId: 'i1', categoryId, signal: 'gps', confidence: 1.5 }),
    ).toThrow();
    expect(() =>
      repo.assignAuto({ itemId: 'i1', categoryId, signal: 'gps', confidence: -0.1 }),
    ).toThrow();
    // No partial write: the two rejected calls must not have modified the stored row
    // (confidence still 1 from the last accepted write, still exactly one auto row).
    expect(storedRow(db, 'i1', categoryId, 'auto')?.confidence).toBe(1);
    expect(
      count(db, "SELECT COUNT(*) n FROM item_categories WHERE item_id='i1' AND source='auto'"),
    ).toBe(1);
  });

  it('throws a FK error for an unknown item or category and writes nothing', () => {
    expect(() => repo.assignAuto({ itemId: 'ghost', categoryId, signal: 'gps' })).toThrow();
    expect(() => repo.assignAuto({ itemId: 'i1', categoryId: 'ghost', signal: 'gps' })).toThrow();
    expect(count(db, 'SELECT COUNT(*) n FROM item_categories')).toBe(0);
  });

  it('USER confirm wins over auto — both rows retained, user provenance surfaced', () => {
    repo.assignAuto({
      itemId: 'i1',
      categoryId,
      signal: 'gps',
      confidence: 0.6,
      explanation: 'auto reason',
    });
    repo.setUserAssignment({
      itemId: 'i1',
      categoryId,
      state: 'assigned',
      explanation: 'user confirmed',
    });

    // Resolution surfaces the USER row (certain: signal 'user', confidence NULL).
    expect(repo.resolveAssignment('i1', categoryId)).toEqual({
      itemId: 'i1',
      categoryId,
      source: 'user',
      state: 'assigned',
      signal: 'user',
      confidence: null,
      explanation: 'user confirmed',
    });
    // BOTH rows are retained (dedup-with-provenance) — auto is kept underneath, unchanged.
    expect(count(db, "SELECT COUNT(*) n FROM item_categories WHERE item_id='i1'")).toBe(2);
    expect(storedRow(db, 'i1', categoryId, 'auto')).toMatchObject({
      state: 'assigned',
      signal: 'gps',
      confidence: 0.6,
      explanation: 'auto reason',
    });
  });

  it('a USER removed tombstone HIDES an auto membership (auto retained underneath)', () => {
    repo.assignAuto({ itemId: 'i1', categoryId, signal: 'gps', confidence: 0.9 });
    repo.setUserAssignment({
      itemId: 'i1',
      categoryId,
      state: 'removed',
      explanation: 'not this place',
    });

    const eff = repo.resolveAssignment('i1', categoryId);
    expect(eff?.source).toBe('user');
    expect(eff?.state).toBe('removed'); // membership hidden — the caller reads 'removed' as not-a-member
    // The auto row survives underneath (unchanged), ready to explain provenance.
    expect(storedRow(db, 'i1', categoryId, 'auto')).toMatchObject({
      state: 'assigned',
      confidence: 0.9,
    });
  });

  it('resolves a user-only assignment (no auto row) as user/assigned', () => {
    repo.setUserAssignment({ itemId: 'i1', categoryId, state: 'assigned' });

    const eff = repo.resolveAssignment('i1', categoryId);
    expect(eff?.source).toBe('user');
    expect(eff?.state).toBe('assigned');
    expect(eff?.signal).toBe('user');
  });
});

describe('createCategoriesRepo — correction durability (AC-30): auto re-cluster never clobbers a user row', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: CategoriesRepo;
  let categoryId: string;

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createCategoriesRepo(db);
    catalog.insertItem({ id: 'i1', mediaType: 'message', description: 'photo i1' });
    categoryId = repo.upsertCategory({
      kind: 'place',
      name: 'Cusco, Perú',
      sourceKey: 'place:3931198',
    });
  });
  afterEach(() => db.close());

  it('a re-cluster (auto re-write) does NOT overwrite a user CONFIRM', () => {
    repo.assignAuto({
      itemId: 'i1',
      categoryId,
      signal: 'gps',
      confidence: 0.6,
      explanation: 'auto v1',
    });
    repo.setUserAssignment({
      itemId: 'i1',
      categoryId,
      state: 'assigned',
      explanation: 'user confirmed',
    });

    // Re-cluster writes a fresh AUTO row with new values.
    repo.assignAuto({
      itemId: 'i1',
      categoryId,
      signal: 'gps',
      confidence: 0.99,
      explanation: 'auto v2',
    });

    // The USER row is byte-for-byte untouched by the auto re-write.
    expect(storedRow(db, 'i1', categoryId, 'user')).toMatchObject({
      state: 'assigned',
      signal: 'user',
      confidence: null,
      explanation: 'user confirmed',
    });
    // The auto row WAS refreshed by the re-cluster (they coexist — exactly 2 rows).
    expect(storedRow(db, 'i1', categoryId, 'auto')).toMatchObject({
      confidence: 0.99,
      explanation: 'auto v2',
    });
    expect(count(db, "SELECT COUNT(*) n FROM item_categories WHERE item_id='i1'")).toBe(2);
    // Resolution still returns the durable user decision.
    expect(repo.resolveAssignment('i1', categoryId)?.explanation).toBe('user confirmed');
  });

  it('a re-cluster (auto re-write) NEVER resurrects a user-REMOVED tombstone', () => {
    repo.assignAuto({ itemId: 'i1', categoryId, signal: 'gps', confidence: 0.6 });
    repo.setUserAssignment({
      itemId: 'i1',
      categoryId,
      state: 'removed',
      explanation: 'user removed',
    });

    // A later re-cluster tries to (re)assign the item to the same category.
    repo.assignAuto({ itemId: 'i1', categoryId, signal: 'gps', confidence: 0.95 });

    // The tombstone survives — the membership stays HIDDEN across re-clustering (AC-30).
    expect(storedRow(db, 'i1', categoryId, 'user')).toMatchObject({
      state: 'removed',
      explanation: 'user removed',
    });
    const eff = repo.resolveAssignment('i1', categoryId);
    expect(eff?.source).toBe('user');
    expect(eff?.state).toBe('removed');
    // The auto row underneath was refreshed but its membership never resurfaces.
    expect(storedRow(db, 'i1', categoryId, 'auto')).toMatchObject({ confidence: 0.95 });
  });

  it('a user write is symmetric — it never touches the coexisting auto row', () => {
    repo.assignAuto({
      itemId: 'i1',
      categoryId,
      signal: 'gps',
      confidence: 0.6,
      explanation: 'auto',
    });
    repo.setUserAssignment({ itemId: 'i1', categoryId, state: 'removed' });

    expect(storedRow(db, 'i1', categoryId, 'auto')).toMatchObject({
      state: 'assigned',
      signal: 'gps',
      confidence: 0.6,
      explanation: 'auto',
    });
  });
});

describe('createCategoriesRepo — assignments are removable renditions (AC-14 cascade)', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: CategoriesRepo;
  let categoryId: string;

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createCategoriesRepo(db);
    catalog.insertItem({ id: 'i1', mediaType: 'message', description: 'photo i1' });
    categoryId = repo.upsertCategory({ kind: 'place', name: 'Cusco', sourceKey: 'place:1' });
    repo.assignAuto({ itemId: 'i1', categoryId, signal: 'gps', confidence: 0.7 });
    repo.setUserAssignment({ itemId: 'i1', categoryId, state: 'assigned' });
  });
  afterEach(() => db.close());

  it('deleting the item cascades away ALL its assignment rows', () => {
    expect(count(db, "SELECT COUNT(*) n FROM item_categories WHERE item_id='i1'")).toBe(2);
    db.prepare("DELETE FROM items WHERE id='i1'").run();
    expect(count(db, 'SELECT COUNT(*) n FROM item_categories')).toBe(0);
  });

  it('deleting the category cascades away ALL its assignment rows', () => {
    db.prepare('DELETE FROM categories WHERE id = ?').run(categoryId);
    expect(count(db, 'SELECT COUNT(*) n FROM item_categories')).toBe(0);
  });
});
