import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { type Database as Db } from 'better-sqlite3';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';
import {
  createCategoriesRepo,
  type CategoriesRepo,
  type CategoryKind,
} from '../../electron/main/categorize/categories-repo';
import {
  DEFAULT_MIN_MEMBERS,
  deriveSuggestionCandidates,
  type SuggestionCandidate,
} from '../../electron/main/categorize/suggestions-derive';

// A real in-memory better-sqlite3 catalog with every migration applied (NO db
// mocking) — the same fixture shape categories-repo.test.ts uses, so derivation
// runs against the live migration-005 schema (categories / item_categories /
// collections provenance columns). Suggestion derivation is a PURE read model:
// these tests pin its determinism, its exclusion of accepted/dismissed
// categories, its honouring of effective membership (user-wins + removed
// tombstone), and — the headline invariant — that it writes NOTHING.

function freshCatalog(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); // enforce the FK links (collections.category_id, item_categories)
  runMigrations(db);
  return db;
}

function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{ n: number }>() as { n: number }).n;
}

/** Seed `n` real items (item-01 … item-NN) so assignments satisfy the FK. */
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

/** Insert a collections row directly (no curation repo exists yet — that is M4-3b). */
function insertCollection(
  db: Db,
  opts: {
    id: string;
    name: string;
    origin: 'user' | 'suggested' | 'dismissed';
    categoryId: string | null;
  },
): void {
  db.prepare('INSERT INTO collections (id, name, origin, category_id) VALUES (?, ?, ?, ?)').run(
    opts.id,
    opts.name,
    opts.origin,
    opts.categoryId,
  );
}

/** A full-content snapshot of the tables derivation reads — to prove it writes nothing. */
function snapshot(db: Db): Record<string, unknown[]> {
  return {
    categories: db.prepare('SELECT * FROM categories ORDER BY id').all(),
    itemCategories: db
      .prepare('SELECT * FROM item_categories ORDER BY item_id, category_id, source')
      .all(),
    collections: db.prepare('SELECT * FROM collections ORDER BY id').all(),
  };
}

describe('deriveSuggestionCandidates — candidate selection, threshold & ordering', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: CategoriesRepo;
  let items: string[];

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createCategoriesRepo(db);
    items = seedItems(catalog, 12);
  });
  afterEach(() => db.close());

  it('returns place AND theme candidates at/above the threshold, ordered by count desc then id asc', () => {
    autoCategory(repo, {
      id: 'cat-theme-2',
      kind: 'theme',
      name: 'Beach',
      sourceKey: 'theme:bbb',
      members: items.slice(0, 5),
    });
    autoCategory(repo, {
      id: 'cat-place-1',
      kind: 'place',
      name: 'Cusco',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });
    autoCategory(repo, {
      id: 'cat-theme-1',
      kind: 'theme',
      name: 'Birthday',
      sourceKey: 'theme:aaa',
      members: items.slice(0, 4),
    });
    autoCategory(repo, {
      id: 'cat-place-2',
      kind: 'place',
      name: 'Lima',
      sourceKey: 'place:2',
      members: items.slice(0, 2),
    });

    const expected: SuggestionCandidate[] = [
      {
        categoryId: 'cat-theme-2',
        kind: 'theme',
        name: 'Beach',
        sourceKey: 'theme:bbb',
        memberCount: 5,
      },
      {
        categoryId: 'cat-place-1',
        kind: 'place',
        name: 'Cusco',
        sourceKey: 'place:1',
        memberCount: 4,
      },
      {
        categoryId: 'cat-theme-1',
        kind: 'theme',
        name: 'Birthday',
        sourceKey: 'theme:aaa',
        memberCount: 4,
      },
    ];
    // Lima (2 members) is below the threshold and excluded; the two 4-member
    // categories tie-break by id asc (cat-place-1 before cat-theme-1).
    expect(deriveSuggestionCandidates(db, { minMembers: 3 })).toEqual(expected);
  });

  it('is a total, deterministic order — same DB state yields the identical list every call', () => {
    autoCategory(repo, {
      id: 'cat-b',
      kind: 'place',
      name: 'B',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });
    autoCategory(repo, {
      id: 'cat-a',
      kind: 'theme',
      name: 'A',
      sourceKey: 'theme:a',
      members: items.slice(0, 4),
    });
    autoCategory(repo, {
      id: 'cat-c',
      kind: 'place',
      name: 'C',
      sourceKey: 'place:2',
      members: items.slice(0, 4),
    });

    const first = deriveSuggestionCandidates(db, { minMembers: 3 });
    // All three tie at 4 members → pure id-asc order, stable across repeated calls.
    expect(first.map((c) => c.categoryId)).toEqual(['cat-a', 'cat-b', 'cat-c']);
    expect(deriveSuggestionCandidates(db, { minMembers: 3 })).toEqual(first);
  });

  it('returns an empty list when no category meets the threshold', () => {
    autoCategory(repo, {
      id: 'c1',
      kind: 'place',
      name: 'X',
      sourceKey: 'place:1',
      members: items.slice(0, 2),
    });
    autoCategory(repo, {
      id: 'c2',
      kind: 'theme',
      name: 'Y',
      sourceKey: 'theme:a',
      members: items.slice(0, 1),
    });

    expect(deriveSuggestionCandidates(db, { minMembers: 3 })).toEqual([]);
  });

  it('returns an empty list for a catalog with no categories at all', () => {
    expect(deriveSuggestionCandidates(db, { minMembers: 3 })).toEqual([]);
  });

  it('applies DEFAULT_MIN_MEMBERS (=3) when no threshold is provided', () => {
    expect(DEFAULT_MIN_MEMBERS).toBe(3);
    autoCategory(repo, {
      id: 'at',
      kind: 'place',
      name: 'At',
      sourceKey: 'place:1',
      members: items.slice(0, DEFAULT_MIN_MEMBERS),
    });
    autoCategory(repo, {
      id: 'below',
      kind: 'theme',
      name: 'Below',
      sourceKey: 'theme:a',
      members: items.slice(0, DEFAULT_MIN_MEMBERS - 1),
    });

    const result = deriveSuggestionCandidates(db);
    expect(result.map((c) => c.categoryId)).toEqual(['at']);
    expect(result[0]?.memberCount).toBe(DEFAULT_MIN_MEMBERS);
  });
});

describe('deriveSuggestionCandidates — kind scope (places/themes only)', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: CategoriesRepo;
  let items: string[];

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createCategoriesRepo(db);
    items = seedItems(catalog, 12);
  });
  afterEach(() => db.close());

  it('never suggests a person category, even with many effective members', () => {
    autoCategory(repo, {
      id: 'person-1',
      kind: 'person',
      name: 'Mom',
      sourceKey: 'person:1',
      members: items.slice(0, 10),
    });
    autoCategory(repo, {
      id: 'place-1',
      kind: 'place',
      name: 'Cusco',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });

    const result = deriveSuggestionCandidates(db, { minMembers: 3 });
    // The 10-member person category is out of scope; only the place surfaces.
    expect(result.map((c) => c.categoryId)).toEqual(['place-1']);
  });
});

describe('deriveSuggestionCandidates — exclusion of accepted/dismissed categories', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: CategoriesRepo;
  let items: string[];

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createCategoriesRepo(db);
    items = seedItems(catalog, 12);
  });
  afterEach(() => db.close());

  it("excludes a category already accepted as a collection (origin='suggested')", () => {
    const accepted = autoCategory(repo, {
      id: 'accepted',
      kind: 'place',
      name: 'Cusco',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });
    autoCategory(repo, {
      id: 'open',
      kind: 'theme',
      name: 'Beach',
      sourceKey: 'theme:a',
      members: items.slice(0, 4),
    });
    insertCollection(db, {
      id: 'col-1',
      name: 'Cusco trip',
      origin: 'suggested',
      categoryId: accepted,
    });

    expect(deriveSuggestionCandidates(db, { minMembers: 3 }).map((c) => c.categoryId)).toEqual([
      'open',
    ]);
  });

  it("excludes a category dismissed via a tombstone collection (origin='dismissed')", () => {
    const dismissed = autoCategory(repo, {
      id: 'dismissed',
      kind: 'place',
      name: 'Lima',
      sourceKey: 'place:2',
      members: items.slice(0, 4),
    });
    autoCategory(repo, {
      id: 'open',
      kind: 'theme',
      name: 'Beach',
      sourceKey: 'theme:a',
      members: items.slice(0, 4),
    });
    insertCollection(db, {
      id: 'col-tomb',
      name: 'Lima',
      origin: 'dismissed',
      categoryId: dismissed,
    });

    expect(deriveSuggestionCandidates(db, { minMembers: 3 }).map((c) => c.categoryId)).toEqual([
      'open',
    ]);
  });

  it('ignores hand-made user collections and only excludes the specifically linked category', () => {
    autoCategory(repo, {
      id: 'cand',
      kind: 'place',
      name: 'Cusco',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });
    const other = autoCategory(repo, {
      id: 'other',
      kind: 'theme',
      name: 'Beach',
      sourceKey: 'theme:a',
      members: items.slice(0, 4),
    });
    // A hand-made collection (category_id NULL) must not affect derivation.
    insertCollection(db, {
      id: 'user-col',
      name: 'My favourites',
      origin: 'user',
      categoryId: null,
    });
    // A suggested collection for `other` excludes ONLY `other`, never `cand`.
    insertCollection(db, {
      id: 'sug-other',
      name: 'Beach',
      origin: 'suggested',
      categoryId: other,
    });

    expect(deriveSuggestionCandidates(db, { minMembers: 3 }).map((c) => c.categoryId)).toEqual([
      'cand',
    ]);
  });

  it('returns an empty list when every qualifying category is accepted or dismissed', () => {
    const a = autoCategory(repo, {
      id: 'a',
      kind: 'place',
      name: 'A',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });
    const b = autoCategory(repo, {
      id: 'b',
      kind: 'theme',
      name: 'B',
      sourceKey: 'theme:a',
      members: items.slice(0, 4),
    });
    insertCollection(db, { id: 'ca', name: 'A', origin: 'suggested', categoryId: a });
    insertCollection(db, { id: 'cb', name: 'B', origin: 'dismissed', categoryId: b });

    expect(deriveSuggestionCandidates(db, { minMembers: 3 })).toEqual([]);
  });
});

describe('deriveSuggestionCandidates — effective membership (user-wins, removed tombstone)', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: CategoriesRepo;
  let items: string[];

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createCategoriesRepo(db);
    items = seedItems(catalog, 12);
  });
  afterEach(() => db.close());

  it('a user-removed tombstone drops a member below the threshold, hiding the category', () => {
    const cat = autoCategory(repo, {
      id: 'cat',
      kind: 'place',
      name: 'Cusco',
      sourceKey: 'place:1',
      members: items.slice(0, 3),
    });

    // Exactly 3 effective auto members → qualifies at threshold 3.
    const before = deriveSuggestionCandidates(db, { minMembers: 3 });
    expect(before.map((c) => c.categoryId)).toEqual(['cat']);
    expect(before[0]?.memberCount).toBe(3);

    // A user removes one member → 2 effective → below threshold → gone.
    repo.setUserAssignment({ itemId: items[0], categoryId: cat, state: 'removed' });
    expect(deriveSuggestionCandidates(db, { minMembers: 3 })).toEqual([]);
  });

  it('a user-assigned NEW member adds one; confirming an existing auto member never double-counts', () => {
    const cat = autoCategory(repo, {
      id: 'cat',
      kind: 'theme',
      name: 'Beach',
      sourceKey: 'theme:a',
      members: items.slice(0, 2),
    });

    // 2 auto members → below threshold 3.
    expect(deriveSuggestionCandidates(db, { minMembers: 3 })).toEqual([]);

    // Confirming an EXISTING auto member (user wins, both rows retained) must NOT
    // increase the effective count — still 2.
    repo.setUserAssignment({ itemId: items[0], categoryId: cat, state: 'assigned' });
    expect(deriveSuggestionCandidates(db, { minMembers: 3 })).toEqual([]);

    // A user-assigned NEW item (no auto row) adds a third effective member → qualifies.
    repo.setUserAssignment({ itemId: items[2], categoryId: cat, state: 'assigned' });
    const result = deriveSuggestionCandidates(db, { minMembers: 3 });
    expect(result.map((c) => c.categoryId)).toEqual(['cat']);
    expect(result[0]?.memberCount).toBe(3);
  });
});

describe('deriveSuggestionCandidates — read-only invariant (writes nothing)', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: CategoriesRepo;
  let items: string[];

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createCategoriesRepo(db);
    items = seedItems(catalog, 12);
  });
  afterEach(() => db.close());

  it('derives a non-empty candidate list without INSERT/UPDATE/DELETE of any row', () => {
    const c1 = autoCategory(repo, {
      id: 'c1',
      kind: 'place',
      name: 'Cusco',
      sourceKey: 'place:1',
      members: items.slice(0, 4),
    });
    autoCategory(repo, {
      id: 'c2',
      kind: 'theme',
      name: 'Beach',
      sourceKey: 'theme:a',
      members: items.slice(0, 5),
    });
    const c3 = autoCategory(repo, {
      id: 'c3',
      kind: 'place',
      name: 'Lima',
      sourceKey: 'place:2',
      members: items.slice(0, 3),
    });
    // A user confirm + a user removed tombstone on c1 → c1 effective count is 3.
    repo.setUserAssignment({ itemId: items[2], categoryId: c1, state: 'assigned' });
    repo.setUserAssignment({ itemId: items[0], categoryId: c1, state: 'removed' });
    // c3 is accepted (excluded); a hand-made user collection is present too.
    insertCollection(db, { id: 'col-s', name: 'Lima', origin: 'suggested', categoryId: c3 });
    insertCollection(db, { id: 'col-u', name: 'Fav', origin: 'user', categoryId: null });

    const beforeCounts = {
      categories: count(db, 'categories'),
      itemCategories: count(db, 'item_categories'),
      collections: count(db, 'collections'),
      items: count(db, 'items'),
    };
    const before = snapshot(db);

    const result = deriveSuggestionCandidates(db, { minMembers: 3 });
    // Discriminating: c2 (5) then c1 (4 auto − 1 removed = 3); c3 excluded (accepted).
    expect(result).toEqual([
      { categoryId: 'c2', kind: 'theme', name: 'Beach', sourceKey: 'theme:a', memberCount: 5 },
      { categoryId: 'c1', kind: 'place', name: 'Cusco', sourceKey: 'place:1', memberCount: 3 },
    ]);

    // A second call is byte-identical (determinism) and still writes nothing.
    expect(deriveSuggestionCandidates(db, { minMembers: 3 })).toEqual(result);

    const afterCounts = {
      categories: count(db, 'categories'),
      itemCategories: count(db, 'item_categories'),
      collections: count(db, 'collections'),
      items: count(db, 'items'),
    };
    expect(afterCounts).toEqual(beforeCounts);
    // Row counts AND full row content are unchanged — no silent UPDATE either.
    expect(snapshot(db)).toEqual(before);
  });
});
