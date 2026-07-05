import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { type Database as Db } from 'better-sqlite3';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';
import {
  createCategoriesRepo,
  type CategoriesRepo,
  type CategoryKind,
} from '../../electron/main/categorize/categories-repo';
import { deriveSuggestionCandidates } from '../../electron/main/categorize/suggestions-derive';
import {
  createCurationRepo,
  type CurationRepo,
} from '../../electron/main/categorize/curation-repo';

// A real in-memory better-sqlite3 catalog with every migration applied (NO db
// mocking) — the same fixture shape categories-repo.test.ts / suggestions-derive
// .test.ts use, so the curation WRITES run against the live migration-005 schema
// (collections.origin / collections.category_id / collection_items). The curation
// repo is the write half of suggested collections: accept materializes a
// suggestion into a real collection, rename edits it, merge folds one collection
// into another (tombstoning the merged-away category), and dismiss drops a durable
// tombstone. Its headline invariant (AC-32) is that a `collections` row is created
// ONLY here, from an explicit user action — never as a side effect of derivation —
// which these tests prove by round-tripping through the real
// `deriveSuggestionCandidates` read model.

function freshCatalog(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); // enforce collections.category_id + collection_items FKs/cascades
  runMigrations(db);
  return db;
}

/** Count rows for an arbitrary aggregate SELECT (optionally parameterised). */
function count(db: Db, sql: string, ...params: readonly unknown[]): number {
  const row = db.prepare(sql).get<{ n: number }>(...params) as { n: number };
  return Number(row.n);
}

/** Seed `n` real items (item-01 … item-NN) so assignments/collection_items satisfy the FK. */
function seedItems(catalog: CatalogRepo, n: number): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    const id = `item-${String(i).padStart(2, '0')}`;
    catalog.insertItem({ id, mediaType: 'photo', description: `photo ${id}` });
    ids.push(id);
  }
  return ids;
}

const SIGNAL_BY_KIND: Record<CategoryKind, 'gps' | 'theme-cluster' | 'face-cluster'> = {
  place: 'gps',
  theme: 'theme-cluster',
  person: 'face-cluster',
};

/** Upsert a category and AUTO-assign each member item to it; returns the category id. */
function autoCategory(
  repo: CategoriesRepo,
  opts: {
    id: string;
    kind: CategoryKind;
    name: string;
    sourceKey: string;
    members: readonly string[];
  },
): string {
  const id = repo.upsertCategory({
    id: opts.id,
    kind: opts.kind,
    name: opts.name,
    sourceKey: opts.sourceKey,
  });
  for (const itemId of opts.members) {
    repo.assignAuto({ itemId, categoryId: id, signal: SIGNAL_BY_KIND[opts.kind] });
  }
  return id;
}

/** The stored shape of a collections row (asserted directly to prove provenance). */
interface StoredCollection {
  id: string;
  name: string;
  origin: string;
  category_id: string | null;
}

function collectionRow(db: Db, id: string): StoredCollection | undefined {
  return db
    .prepare('SELECT id, name, origin, category_id FROM collections WHERE id = ?')
    .get<StoredCollection>(id);
}

/** The member item ids of a collection, ordered for a stable comparison. */
function memberItemIds(db: Db, collectionId: string): string[] {
  return db
    .prepare('SELECT item_id FROM collection_items WHERE collection_id = ? ORDER BY item_id')
    .all<{ item_id: string }>(collectionId)
    .map((r) => r.item_id);
}

/** The single dismissed tombstone linked to a category, or undefined. */
function dismissedTombstone(db: Db, categoryId: string): StoredCollection | undefined {
  return db
    .prepare(
      "SELECT id, name, origin, category_id FROM collections WHERE origin = 'dismissed' AND category_id = ?",
    )
    .get<StoredCollection>(categoryId);
}

/** Insert a hand-made collection + members directly (no curation call). */
function insertUserCollection(
  db: Db,
  id: string,
  name: string,
  memberIds: readonly string[],
): void {
  db.prepare(
    "INSERT INTO collections (id, name, origin, category_id) VALUES (?, ?, 'user', NULL)",
  ).run(id, name);
  for (const itemId of memberIds) {
    db.prepare('INSERT INTO collection_items (collection_id, item_id) VALUES (?, ?)').run(
      id,
      itemId,
    );
  }
}

describe('createCurationRepo — accept (materialise a suggested collection)', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: CategoriesRepo;
  let curation: CurationRepo;
  let items: string[];

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createCategoriesRepo(db);
    curation = createCurationRepo(db);
    items = seedItems(catalog, 12);
  });
  afterEach(() => db.close());

  it("materialises one origin='suggested' collection linked to the category, defaulting its name", () => {
    const cat = autoCategory(repo, {
      id: 'cat-cusco',
      kind: 'place',
      name: 'Cusco, Perú',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });

    const collectionId = curation.accept({ categoryId: cat });

    expect(collectionRow(db, collectionId)).toMatchObject({
      id: collectionId,
      name: 'Cusco, Perú', // defaulted from the category's current name
      origin: 'suggested',
      category_id: cat,
    });
    // Exactly one suggested collection exists — nothing else was created.
    expect(count(db, "SELECT COUNT(*) AS n FROM collections WHERE origin = 'suggested'")).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM collections')).toBe(1);
  });

  it('copies exactly the EFFECTIVE members (user-wins + removed tombstone), each item once', () => {
    const cat = autoCategory(repo, {
      id: 'cat',
      kind: 'place',
      name: 'Cusco',
      sourceKey: 'place:1',
      members: items.slice(0, 4), // auto: item-01..04
    });
    repo.setUserAssignment({ itemId: items[0], categoryId: cat, state: 'removed' }); // item-01 hidden
    repo.setUserAssignment({ itemId: items[1], categoryId: cat, state: 'assigned' }); // item-02 confirmed (auto+user)
    repo.setUserAssignment({ itemId: items[4], categoryId: cat, state: 'assigned' }); // item-05 user-only new

    const collectionId = curation.accept({ categoryId: cat });

    // item-01 removed → excluded; item-02 confirmed → once (not doubled); item-03/04
    // auto → included; item-05 user-only → included.
    expect(memberItemIds(db, collectionId)).toEqual([items[1], items[2], items[3], items[4]]);
    expect(
      count(db, 'SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?', collectionId),
    ).toBe(4);
  });

  it('accepts a name override and a caller-provided collection id', () => {
    const cat = autoCategory(repo, {
      id: 'cat',
      kind: 'theme',
      name: 'Auto Name',
      sourceKey: 'theme:a',
      members: items.slice(0, 3),
    });

    const id = curation.accept({ categoryId: cat, name: 'Our Beach Trip', id: 'col-fixed' });

    expect(id).toBe('col-fixed');
    expect(collectionRow(db, 'col-fixed')).toMatchObject({
      name: 'Our Beach Trip',
      origin: 'suggested',
      category_id: cat,
    });
  });

  it('throws for an unknown category and writes no collection', () => {
    expect(() => curation.accept({ categoryId: 'ghost' })).toThrow();
    expect(count(db, 'SELECT COUNT(*) AS n FROM collections')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM collection_items')).toBe(0);
  });

  it('after accept, deriveSuggestionCandidates no longer returns the category (round-trip)', () => {
    const cat = autoCategory(repo, {
      id: 'cat',
      kind: 'place',
      name: 'Cusco',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });
    autoCategory(repo, {
      id: 'other',
      kind: 'theme',
      name: 'Beach',
      sourceKey: 'theme:a',
      members: items.slice(0, 4),
    });
    // Both qualify before acceptance (tie at 4 → id asc).
    expect(deriveSuggestionCandidates(db, { minMembers: 3 }).map((c) => c.categoryId)).toEqual([
      'cat',
      'other',
    ]);

    curation.accept({ categoryId: cat });

    // The accepted category is now excluded; the other remains proposable.
    expect(deriveSuggestionCandidates(db, { minMembers: 3 }).map((c) => c.categoryId)).toEqual([
      'other',
    ]);
  });
});

describe('createCurationRepo — rename', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: CategoriesRepo;
  let curation: CurationRepo;
  let items: string[];

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createCategoriesRepo(db);
    curation = createCurationRepo(db);
    items = seedItems(catalog, 12);
  });
  afterEach(() => db.close());

  it('updates the collection name, leaving origin, provenance link and members intact', () => {
    const cat = autoCategory(repo, {
      id: 'cat',
      kind: 'place',
      name: 'Cusco',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });
    const id = curation.accept({ categoryId: cat, name: 'Old name' });
    const membersBefore = memberItemIds(db, id);

    curation.rename({ collectionId: id, name: 'New name' });

    expect(collectionRow(db, id)).toMatchObject({
      id,
      name: 'New name',
      origin: 'suggested', // unchanged
      category_id: cat, // unchanged
    });
    expect(memberItemIds(db, id)).toEqual(membersBefore); // membership untouched
  });

  it('throws when renaming an unknown collection (no row updated)', () => {
    expect(() => curation.rename({ collectionId: 'ghost', name: 'X' })).toThrow();
  });
});

describe('createCurationRepo — merge (fold one collection into another)', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: CategoriesRepo;
  let curation: CurationRepo;
  let items: string[];

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createCategoriesRepo(db);
    curation = createCurationRepo(db);
    items = seedItems(catalog, 12);
  });
  afterEach(() => db.close());

  it('moves members into the survivor (no dupes), deletes the merged-away collection, tombstones its category, and leaves both category rows intact', () => {
    const cf = autoCategory(repo, {
      id: 'cf',
      kind: 'place',
      name: 'From',
      sourceKey: 'place:1',
      members: [items[0], items[1], items[2]], // item-01,02,03
    });
    const ci = autoCategory(repo, {
      id: 'ci',
      kind: 'theme',
      name: 'Into',
      sourceKey: 'theme:a',
      members: [items[2], items[3], items[4]], // item-03,04,05 (item-03 overlaps)
    });
    const fromId = curation.accept({ categoryId: cf });
    const intoId = curation.accept({ categoryId: ci });

    curation.merge({ fromCollectionId: fromId, intoCollectionId: intoId });

    // Survivor holds the UNION, each item exactly once (item-03 not doubled).
    expect(memberItemIds(db, intoId)).toEqual([items[0], items[1], items[2], items[3], items[4]]);
    // The merged-away collection is gone — row and its collection_items both cascade away.
    expect(collectionRow(db, fromId)).toBeUndefined();
    expect(
      count(db, 'SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?', fromId),
    ).toBe(0);
    // A member-less dismissed tombstone now links from's category (so it is not re-proposed).
    const tomb = dismissedTombstone(db, cf);
    expect(tomb).toBeDefined();
    expect(tomb?.origin).toBe('dismissed');
    expect(tomb?.category_id).toBe(cf);
    expect(
      count(db, 'SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?', tomb?.id),
    ).toBe(0);
    // Into's category is NOT tombstoned.
    expect(dismissedTombstone(db, ci)).toBeUndefined();
    // Both original category rows survive (merge never deletes a category).
    expect(repo.getCategory(cf)).not.toBeNull();
    expect(repo.getCategory(ci)).not.toBeNull();
  });

  it('the merge tombstone keeps the from-category out of future suggestions (round-trip)', () => {
    const cf = autoCategory(repo, {
      id: 'cf',
      kind: 'place',
      name: 'From',
      sourceKey: 'place:1',
      members: items.slice(0, 3), // 3 effective members — qualifies at threshold 3
    });
    const ci = autoCategory(repo, {
      id: 'ci',
      kind: 'theme',
      name: 'Into',
      sourceKey: 'theme:a',
      members: items.slice(3, 7), // item-04..07
    });
    const fromId = curation.accept({ categoryId: cf });
    const intoId = curation.accept({ categoryId: ci });
    // Both accepted → neither is proposed.
    expect(deriveSuggestionCandidates(db, { minMembers: 3 })).toEqual([]);

    curation.merge({ fromCollectionId: fromId, intoCollectionId: intoId });

    // fromId is deleted, yet cf still has its 3 auto memberships in item_categories
    // (merge never touches item_categories). The dismissed tombstone is the only
    // thing excluding cf — derive STILL returns nothing.
    expect(deriveSuggestionCandidates(db, { minMembers: 3 })).toEqual([]);
    // Prove it is the tombstone (not cf's disappearance) doing the work: drop the
    // tombstone and cf re-surfaces as a candidate (ci stays excluded by its survivor).
    db.prepare("DELETE FROM collections WHERE origin = 'dismissed' AND category_id = ?").run(cf);
    expect(deriveSuggestionCandidates(db, { minMembers: 3 }).map((c) => c.categoryId)).toEqual([
      'cf',
    ]);
  });

  it('merging a hand-made collection (no category) moves its members but creates no tombstone', () => {
    insertUserCollection(db, 'user-col', 'My favourites', [items[0], items[1]]);
    const ci = autoCategory(repo, {
      id: 'ci',
      kind: 'theme',
      name: 'Into',
      sourceKey: 'theme:a',
      members: items.slice(2, 6),
    });
    const intoId = curation.accept({ categoryId: ci });
    const dismissedBefore = count(
      db,
      "SELECT COUNT(*) AS n FROM collections WHERE origin = 'dismissed'",
    );

    curation.merge({ fromCollectionId: 'user-col', intoCollectionId: intoId });

    // Members moved into the survivor.
    expect(memberItemIds(db, intoId)).toEqual(expect.arrayContaining([items[0], items[1]]));
    // The merged-away collection is gone.
    expect(collectionRow(db, 'user-col')).toBeUndefined();
    // No tombstone was created — there was no category to tombstone.
    expect(count(db, "SELECT COUNT(*) AS n FROM collections WHERE origin = 'dismissed'")).toBe(
      dismissedBefore,
    );
  });

  it('throws on a self-merge and writes nothing', () => {
    const cat = autoCategory(repo, {
      id: 'cat',
      kind: 'place',
      name: 'Cusco',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });
    const id = curation.accept({ categoryId: cat });
    const membersBefore = memberItemIds(db, id);

    expect(() => curation.merge({ fromCollectionId: id, intoCollectionId: id })).toThrow();
    // The collection is untouched — still present with the same members, no tombstone.
    expect(collectionRow(db, id)).toBeDefined();
    expect(memberItemIds(db, id)).toEqual(membersBefore);
    expect(count(db, "SELECT COUNT(*) AS n FROM collections WHERE origin = 'dismissed'")).toBe(0);
  });

  it('throws when either collection is unknown', () => {
    const cat = autoCategory(repo, {
      id: 'cat',
      kind: 'place',
      name: 'Cusco',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });
    const id = curation.accept({ categoryId: cat });

    expect(() => curation.merge({ fromCollectionId: 'ghost', intoCollectionId: id })).toThrow();
    expect(() => curation.merge({ fromCollectionId: id, intoCollectionId: 'ghost' })).toThrow();
  });
});

describe('createCurationRepo — dismiss (durable tombstone)', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: CategoriesRepo;
  let curation: CurationRepo;
  let items: string[];

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createCategoriesRepo(db);
    curation = createCurationRepo(db);
    items = seedItems(catalog, 12);
  });
  afterEach(() => db.close());

  it("inserts a member-less origin='dismissed' collection linked to the category", () => {
    const cat = autoCategory(repo, {
      id: 'cat',
      kind: 'place',
      name: 'Lima',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });

    const tombId = curation.dismiss({ categoryId: cat });

    expect(collectionRow(db, tombId)).toMatchObject({
      id: tombId,
      name: 'Lima', // defaulted from the category
      origin: 'dismissed',
      category_id: cat,
    });
    // A tombstone carries NO members.
    expect(
      count(db, 'SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?', tombId),
    ).toBe(0);
  });

  it('is durable: after dismiss, deriveSuggestionCandidates no longer returns the category (round-trip)', () => {
    const cat = autoCategory(repo, {
      id: 'cat',
      kind: 'place',
      name: 'Lima',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });
    autoCategory(repo, {
      id: 'other',
      kind: 'theme',
      name: 'Beach',
      sourceKey: 'theme:a',
      members: items.slice(0, 4),
    });
    expect(deriveSuggestionCandidates(db, { minMembers: 3 }).map((c) => c.categoryId)).toEqual([
      'cat',
      'other',
    ]);

    curation.dismiss({ categoryId: cat });

    // The key durability assertion — the dismiss round-trips through the real read model.
    expect(deriveSuggestionCandidates(db, { minMembers: 3 }).map((c) => c.categoryId)).toEqual([
      'other',
    ]);
  });

  it('accepts a name override and a caller-provided id, returning it', () => {
    const cat = autoCategory(repo, {
      id: 'cat',
      kind: 'theme',
      name: 'Auto',
      sourceKey: 'theme:a',
      members: items.slice(0, 3),
    });

    const id = curation.dismiss({ categoryId: cat, name: 'Not this', id: 'tomb-1' });

    expect(id).toBe('tomb-1');
    expect(collectionRow(db, 'tomb-1')).toMatchObject({ name: 'Not this', origin: 'dismissed' });
  });

  it('throws for an unknown category and writes no collection', () => {
    expect(() => curation.dismiss({ categoryId: 'ghost' })).toThrow();
    expect(count(db, 'SELECT COUNT(*) AS n FROM collections')).toBe(0);
  });
});

describe('createCurationRepo — AC-32: a collections row appears ONLY from an explicit curation action', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: CategoriesRepo;
  let curation: CurationRepo;
  let items: string[];

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createCategoriesRepo(db);
    curation = createCurationRepo(db);
    items = seedItems(catalog, 12);
  });
  afterEach(() => db.close());

  it('derivation alone creates nothing; a suggested row exists only after an explicit accept', () => {
    const cat = autoCategory(repo, {
      id: 'cat',
      kind: 'place',
      name: 'Cusco',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });

    // Reading candidates (even repeatedly) must never materialise a collection.
    deriveSuggestionCandidates(db, { minMembers: 3 });
    deriveSuggestionCandidates(db, { minMembers: 3 });
    expect(count(db, 'SELECT COUNT(*) AS n FROM collections')).toBe(0);

    // Only the explicit user action materialises exactly one suggested row.
    curation.accept({ categoryId: cat });
    expect(count(db, "SELECT COUNT(*) AS n FROM collections WHERE origin = 'suggested'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM collections WHERE origin = 'dismissed'")).toBe(0);
  });

  it('a dismissed row appears only from an explicit dismiss', () => {
    const cat = autoCategory(repo, {
      id: 'cat',
      kind: 'theme',
      name: 'Beach',
      sourceKey: 'theme:a',
      members: items.slice(0, 4),
    });

    deriveSuggestionCandidates(db, { minMembers: 3 });
    expect(count(db, "SELECT COUNT(*) AS n FROM collections WHERE origin = 'dismissed'")).toBe(0);

    curation.dismiss({ categoryId: cat });
    expect(count(db, "SELECT COUNT(*) AS n FROM collections WHERE origin = 'dismissed'")).toBe(1);
  });
});

describe('createCurationRepo — accept/dismiss/merge idempotency (created exactly once per category)', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: CategoriesRepo;
  let curation: CurationRepo;
  let items: string[];

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createCategoriesRepo(db);
    curation = createCurationRepo(db);
    items = seedItems(catalog, 12);
  });
  afterEach(() => db.close());

  it('a second accept of the same category creates NO second suggested collection and returns the same id', () => {
    const cat = autoCategory(repo, {
      id: 'cat',
      kind: 'place',
      name: 'Cusco',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });

    const first = curation.accept({ categoryId: cat });
    // A repeated accept (double-click / IPC retry / stale still-visible card) must be
    // an idempotent no-op — the derivation exclusion is read-only and cannot block a
    // direct second WRITE, so the repo itself has to (AC-32: created exactly once).
    const second = curation.accept({ categoryId: cat });

    expect(second).toBe(first);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM collections WHERE origin = 'suggested' AND category_id = ?",
        cat,
      ),
    ).toBe(1);
    // The one collection's members were not re-copied/duplicated either.
    expect(
      count(db, 'SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?', first),
    ).toBe(4);
  });

  it('the idempotent second accept leaves the already-materialised collection untouched (snapshot)', () => {
    const cat = autoCategory(repo, {
      id: 'cat',
      kind: 'place',
      name: 'Cusco',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });
    const first = curation.accept({ categoryId: cat });
    const membersAfterFirst = memberItemIds(db, first);

    // Effective membership changes after the first accept…
    repo.setUserAssignment({ itemId: items[0], categoryId: cat, state: 'removed' });
    // …but a second accept is a pure no-op: it must NOT re-copy members or mutate the row.
    const second = curation.accept({ categoryId: cat });

    expect(second).toBe(first);
    expect(memberItemIds(db, first)).toEqual(membersAfterFirst);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM collections WHERE origin = 'suggested' AND category_id = ?",
        cat,
      ),
    ).toBe(1);
  });

  it('a second dismiss of the same category creates NO second tombstone and returns the same id', () => {
    const cat = autoCategory(repo, {
      id: 'cat',
      kind: 'theme',
      name: 'Beach',
      sourceKey: 'theme:a',
      members: items.slice(0, 4),
    });

    const first = curation.dismiss({ categoryId: cat });
    const second = curation.dismiss({ categoryId: cat });

    expect(second).toBe(first);
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM collections WHERE origin = 'dismissed' AND category_id = ?",
        cat,
      ),
    ).toBe(1);
  });

  it('merge does not duplicate an existing dismissed tombstone for the merged-away category', () => {
    const cf = autoCategory(repo, {
      id: 'cf',
      kind: 'place',
      name: 'From',
      sourceKey: 'place:1',
      members: items.slice(0, 3),
    });
    const ci = autoCategory(repo, {
      id: 'ci',
      kind: 'theme',
      name: 'Into',
      sourceKey: 'theme:a',
      members: items.slice(3, 7),
    });
    const intoId = curation.accept({ categoryId: ci });
    // A dismissed tombstone for cf already exists…
    const existingTomb = curation.dismiss({ categoryId: cf });
    // …and a separate suggested collection for cf is the one being merged away.
    db.prepare('INSERT INTO collections (id, name, origin, category_id) VALUES (?, ?, ?, ?)').run(
      'from-col',
      'From',
      'suggested',
      cf,
    );
    db.prepare('INSERT INTO collection_items (collection_id, item_id) VALUES (?, ?)').run(
      'from-col',
      items[0],
    );

    curation.merge({ fromCollectionId: 'from-col', intoCollectionId: intoId });

    // Still exactly ONE dismissed tombstone for cf — merge reused it, did not duplicate.
    expect(
      count(
        db,
        "SELECT COUNT(*) AS n FROM collections WHERE origin = 'dismissed' AND category_id = ?",
        cf,
      ),
    ).toBe(1);
    expect(dismissedTombstone(db, cf)?.id).toBe(existingTomb);
    // The merged-away collection is gone and its member moved to the survivor.
    expect(collectionRow(db, 'from-col')).toBeUndefined();
    expect(memberItemIds(db, intoId)).toEqual(expect.arrayContaining([items[0]]));
  });
});
