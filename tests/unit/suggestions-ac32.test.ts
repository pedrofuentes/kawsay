// AC-32 integration test (T-M4-3c / #273): the SUGGESTED-COLLECTIONS review tray,
// exercised end-to-end through the host-side suggestions library port over a REAL
// in-memory better-sqlite3 catalog (NO DB mocking) with every migration applied —
// the same shape the production main process wires, minus Electron. It proves the
// four AC-32 guarantees with concrete, discriminating oracles (rows / ids /
// membership), not "non-empty":
//   1. suggestions surface for review (derived, ordered, with example items);
//   2. a suggestion becomes a real `collections` row ONLY on explicit accept — mere
//      derivation / tray display writes NOTHING (the main list is byte-identical);
//   3. a dismiss is durable — a fresh port over the same on-disk catalog (a
//      "relaunch") never re-proposes it;
//   4. a merge moves the members into the survivor and tombstones the source
//      category so it is not re-proposed.

import { afterEach, describe, expect, it } from 'vitest';
import Database, { type Database as Db } from 'better-sqlite3';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo } from '../../electron/main/db/catalog-repo';
import {
  createCategoriesRepo,
  type CategoriesRepo,
  type CategoryKind,
} from '../../electron/main/categorize/categories-repo';
import { createSuggestionsLibraryPort } from '../../electron/main/categorize/suggestions-library';

// Five photos "at" Cusco → a place category with five effective members.
const PLACE_ITEMS = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000002',
  'aaaaaaaa-0000-4000-8000-000000000003',
  'aaaaaaaa-0000-4000-8000-000000000004',
  'aaaaaaaa-0000-4000-8000-000000000005',
];
// Three messages sharing a theme → a theme category with three members.
const THEME_ITEMS = [
  'bbbbbbbb-0000-4000-8000-000000000001',
  'bbbbbbbb-0000-4000-8000-000000000002',
  'bbbbbbbb-0000-4000-8000-000000000003',
];
// A distinct item that seeds a hand-made collection used as a merge target.
const OTHER_ITEM = 'eeeeeeee-0000-4000-8000-000000000001';

const PLACE_CATEGORY = 'cccc0001-0000-4000-8000-000000000001';
const THEME_CATEGORY = 'cccc0002-0000-4000-8000-000000000002';
const USER_COLLECTION = 'dddd0001-0000-4000-8000-000000000001';

const openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function freshCatalog(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); // enforce collections.category_id + collection_items FKs/cascades
  runMigrations(db);
  openDbs.push(db);
  return db;
}

const SIGNAL_BY_KIND: Record<CategoryKind, 'gps' | 'theme-cluster' | 'face-cluster'> = {
  place: 'gps',
  theme: 'theme-cluster',
  person: 'face-cluster',
};

/** Upsert a category and AUTO-assign each member item to it; returns the category id. */
function autoCategory(
  categories: CategoriesRepo,
  opts: {
    id: string;
    kind: CategoryKind;
    name: string;
    sourceKey: string;
    members: readonly string[];
  },
): string {
  const id = categories.upsertCategory({
    id: opts.id,
    kind: opts.kind,
    name: opts.name,
    sourceKey: opts.sourceKey,
  });
  for (const itemId of opts.members) {
    categories.assignAuto({ itemId, categoryId: id, signal: SIGNAL_BY_KIND[opts.kind] });
  }
  return id;
}

/** Seed the standard corpus: a 5-member place category and a 3-member theme category. */
function seedCorpus(db: Db): void {
  const catalog = createCatalogRepo(db);
  const categories = createCategoriesRepo(db);
  PLACE_ITEMS.forEach((id, i) =>
    catalog.insertItem({ id, mediaType: 'photo', title: `Cusco photo ${i + 1}` }),
  );
  THEME_ITEMS.forEach((id, i) =>
    catalog.insertItem({ id, mediaType: 'message', description: `birthday message ${i + 1}` }),
  );
  autoCategory(categories, {
    id: PLACE_CATEGORY,
    kind: 'place',
    name: 'Cusco, Perú',
    sourceKey: 'place:3941584',
    members: PLACE_ITEMS,
  });
  autoCategory(categories, {
    id: THEME_CATEGORY,
    kind: 'theme',
    name: 'Family birthdays',
    sourceKey: 'theme:birthdays',
    members: THEME_ITEMS,
  });
}

function count(db: Db, sql: string, ...params: readonly unknown[]): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n);
}

interface StoredCollection {
  id: string;
  name: string;
  origin: string;
  category_id: string | null;
}

function collectionsByCategory(db: Db, categoryId: string, origin: string): StoredCollection[] {
  return db
    .prepare(
      'SELECT id, name, origin, category_id FROM collections WHERE category_id = ? AND origin = ?',
    )
    .all<StoredCollection>(categoryId, origin);
}

function memberItemIds(db: Db, collectionId: string): string[] {
  return db
    .prepare('SELECT item_id FROM collection_items WHERE collection_id = ? ORDER BY item_id')
    .all<{ item_id: string }>(collectionId)
    .map((r) => r.item_id);
}

describe('AC-32 — suggestions surface in the review tray (derived, ordered, with examples)', () => {
  it('lists every eligible place/theme category, count-desc then id-asc, with example items', () => {
    const db = freshCatalog();
    seedCorpus(db);
    const port = createSuggestionsLibraryPort({ db });

    const { suggestions } = port.list();

    expect(suggestions.map((s) => s.categoryId)).toEqual([PLACE_CATEGORY, THEME_CATEGORY]);
    const place = suggestions[0];
    expect(place).toMatchObject({ kind: 'place', name: 'Cusco, Perú', memberCount: 5 });
    // "A few example items" — capped below the member count, drawn from the members.
    expect(place.examples).toHaveLength(4);
    expect(place.examples.every((e) => PLACE_ITEMS.includes(e.id))).toBe(true);
    expect(place.examples.every((e) => e.mediaType === 'photo' && e.hasThumbnail)).toBe(true);
    expect(place.examples[0].title).toMatch(/Cusco photo/);

    const theme = suggestions[1];
    expect(theme).toMatchObject({ kind: 'theme', name: 'Family birthdays', memberCount: 3 });
    expect(theme.examples).toHaveLength(3);
    expect(theme.examples.every((e) => !e.hasThumbnail)).toBe(true); // messages are non-visual
  });

  it('respects the minimum-member threshold (a 2-member category is not offered)', () => {
    const db = freshCatalog();
    const catalog = createCatalogRepo(db);
    const categories = createCategoriesRepo(db);
    const small = ['aaaaaaaa-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-0000000000f2'];
    small.forEach((id) => catalog.insertItem({ id, mediaType: 'photo' }));
    autoCategory(categories, {
      id: PLACE_CATEGORY,
      kind: 'place',
      name: 'Tiny',
      sourceKey: 'place:1',
      members: small,
    });

    expect(createSuggestionsLibraryPort({ db }).list().suggestions).toEqual([]);
  });
});

describe('AC-32 — the main collections list is byte-identical until an explicit accept', () => {
  it('derivation and tray display create NO collections rows', () => {
    const db = freshCatalog();
    seedCorpus(db);
    const port = createSuggestionsLibraryPort({ db });

    expect(count(db, 'SELECT COUNT(*) AS n FROM collections')).toBe(0);
    port.list();
    port.list();
    expect(count(db, 'SELECT COUNT(*) AS n FROM collections')).toBe(0);
    // The tray's merge-target list (the real, materialised collections) is empty too.
    expect(port.list().collections).toEqual([]);
  });
});

describe('AC-32 — accept materialises a suggestion into a listed collection', () => {
  it('creates exactly one suggested collection with the members, and lists it as a real collection', () => {
    const db = freshCatalog();
    seedCorpus(db);
    const port = createSuggestionsLibraryPort({ db });

    const afterAccept = port.accept({ categoryId: PLACE_CATEGORY });

    const rows = collectionsByCategory(db, PLACE_CATEGORY, 'suggested');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Cusco, Perú',
      origin: 'suggested',
      category_id: PLACE_CATEGORY,
    });
    expect(memberItemIds(db, rows[0].id)).toEqual([...PLACE_ITEMS].sort());

    // The accepted category drops out of the tray; the theme suggestion remains.
    expect(afterAccept.suggestions.map((s) => s.categoryId)).toEqual([THEME_CATEGORY]);
    // …and it now appears in the real collections list (a merge target).
    expect(afterAccept.collections).toEqual([
      { collectionId: rows[0].id, name: 'Cusco, Perú', origin: 'suggested' },
    ]);
  });

  it('accept is idempotent per category — a repeat never creates a second collection', () => {
    const db = freshCatalog();
    seedCorpus(db);
    const port = createSuggestionsLibraryPort({ db });

    const first = port.accept({ categoryId: PLACE_CATEGORY });
    const second = port.accept({ categoryId: PLACE_CATEGORY });

    expect(count(db, "SELECT COUNT(*) AS n FROM collections WHERE origin = 'suggested'")).toBe(1);
    expect(second.collections).toEqual(first.collections);
  });

  it('accept can rename the collection before materialising it (edit name before accepting)', () => {
    const db = freshCatalog();
    seedCorpus(db);
    const port = createSuggestionsLibraryPort({ db });

    port.accept({ categoryId: THEME_CATEGORY, name: 'Birthdays we shared' });

    expect(collectionsByCategory(db, THEME_CATEGORY, 'suggested')[0].name).toBe(
      'Birthdays we shared',
    );
  });
});

describe('AC-32 — dismiss is durable across a relaunch', () => {
  it('drops a member-less tombstone the derivation never re-proposes — even for a fresh port', () => {
    const db = freshCatalog();
    seedCorpus(db);
    const port = createSuggestionsLibraryPort({ db });

    const afterDismiss = port.dismiss({ categoryId: PLACE_CATEGORY });

    const tombstones = collectionsByCategory(db, PLACE_CATEGORY, 'dismissed');
    expect(tombstones).toHaveLength(1);
    expect(memberItemIds(db, tombstones[0].id)).toEqual([]); // durable, member-less tombstone
    expect(afterDismiss.suggestions.map((s) => s.categoryId)).toEqual([THEME_CATEGORY]);
    // The tombstone is NOT a materialised collection (never a merge target).
    expect(afterDismiss.collections).toEqual([]);

    // "Relaunch": a brand-new port over the SAME on-disk catalog still never re-proposes it.
    const relaunched = createSuggestionsLibraryPort({ db });
    expect(relaunched.list().suggestions.map((s) => s.categoryId)).toEqual([THEME_CATEGORY]);
  });
});

describe('AC-32 — a merge to a valid-uuid-but-nonexistent target is atomic (no orphan)', () => {
  // Regression for #350 — the TOCTOU window between the tray's list() and the
  // merge() call: the chosen survivor may have been deleted (or was never real).
  // Before the fix, port.merge composed curation.accept + curation.merge WITHOUT
  // an outer transaction, so the accept committed FIRST and the merge then threw
  // on the unknown intoCollectionId — leaving a phantom 'suggested' collection
  // for the source category (orphan) with the members already copied into it.
  it('rolls back the accept when the target does not exist — no suggested collection persists, error surfaces', () => {
    const db = freshCatalog();
    seedCorpus(db);
    const port = createSuggestionsLibraryPort({ db });
    // A syntactically valid uuid the tray "listed" but which no longer refers
    // to any collections row (deleted between list() and merge(), or never real).
    const missingTarget = 'ffff0001-0000-4000-8000-000000000001';

    expect(() =>
      port.merge({ categoryId: PLACE_CATEGORY, intoCollectionId: missingTarget }),
    ).toThrow(/unknown collection/i);

    // Full rollback — the source category is NOT silently materialised as its
    // own 'suggested' collection, no tombstone was written, and no members were
    // copied. The whole `collections` table is byte-identical to pre-merge.
    expect(collectionsByCategory(db, PLACE_CATEGORY, 'suggested')).toEqual([]);
    expect(collectionsByCategory(db, PLACE_CATEGORY, 'dismissed')).toEqual([]);
    expect(count(db, 'SELECT COUNT(*) AS n FROM collections')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM collection_items')).toBe(0);
    // …and the suggestion is still offered on the next list() — the user can retry.
    expect(port.list().suggestions.map((s) => s.categoryId)).toEqual([
      PLACE_CATEGORY,
      THEME_CATEGORY,
    ]);
  });
});

describe('AC-32 — merge folds a suggestion into an existing collection', () => {
  it('moves the members into the survivor and tombstones the source category', () => {
    const db = freshCatalog();
    seedCorpus(db);
    const catalog = createCatalogRepo(db);
    catalog.insertItem({ id: OTHER_ITEM, mediaType: 'photo', title: 'Existing member' });
    db.prepare(
      "INSERT INTO collections (id, name, origin, category_id) VALUES (?, 'Our trips', 'user', NULL)",
    ).run(USER_COLLECTION);
    db.prepare('INSERT INTO collection_items (collection_id, item_id) VALUES (?, ?)').run(
      USER_COLLECTION,
      OTHER_ITEM,
    );
    const port = createSuggestionsLibraryPort({ db });

    const afterMerge = port.merge({
      categoryId: PLACE_CATEGORY,
      intoCollectionId: USER_COLLECTION,
    });

    // The survivor gains the place members alongside its pre-existing one (no duplicates).
    expect(memberItemIds(db, USER_COLLECTION)).toEqual([...PLACE_ITEMS, OTHER_ITEM].sort());
    // The source category is tombstoned (durable), with no lingering suggested collection.
    expect(collectionsByCategory(db, PLACE_CATEGORY, 'dismissed')).toHaveLength(1);
    expect(collectionsByCategory(db, PLACE_CATEGORY, 'suggested')).toEqual([]);
    // It is no longer offered; the survivor is still a hand-made collection.
    expect(afterMerge.suggestions.map((s) => s.categoryId)).toEqual([THEME_CATEGORY]);
    expect(afterMerge.collections).toEqual([
      { collectionId: USER_COLLECTION, name: 'Our trips', origin: 'user' },
    ]);
  });
});
