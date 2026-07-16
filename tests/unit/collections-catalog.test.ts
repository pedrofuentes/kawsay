// RED-phase tests for the Collections browser view (#437): the read-only
// backend surface that lists a person's collections and fetches one collection's
// members. Written BEFORE the CatalogRepo/CatalogSession methods exist — every
// `it` here is expected to FAIL until the GREEN commit adds
// `listCollections`/`getCollection` (mirrors `queryTimeline`'s composite keyset
// pattern one layer down; collections are simpler — offset-paginated, since a
// collection's membership is bounded and stable, unlike the ever-growing
// timeline).
//
// Collections are seeded directly against the `collections`/`collection_items`
// tables (ARCHITECTURE §4.2, migration 001 + 005) — the curation-repo write path
// (#272) is a SEPARATE, already-tested module; these tests only exercise the
// NEW read path.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import Database, { type Database as Db } from 'better-sqlite3';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';
import { createCatalogSession } from '../../electron/main/app/catalog-session';
import { openCatalog } from '../../electron/main/db/connection';
import type { IngestionCoordinator } from '../../electron/main/importers/ingestion/coordinator';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

function freshCatalog(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** Insert a collections row directly (bypassing the curation-repo write path,
 *  which is separately tested) — the minimal shape #437's READ path needs. */
function insertCollection(
  db: Db,
  input: { id: string; name: string; origin?: 'user' | 'suggested' | 'dismissed' },
): void {
  db.prepare(
    `INSERT INTO collections (id, name, origin) VALUES (@id, @name, @origin)`,
  ).run({ id: input.id, name: input.name, origin: input.origin ?? 'user' });
}

function insertCollectionItem(
  db: Db,
  input: { collectionId: string; itemId: string; position?: number | null },
): void {
  db.prepare(
    `INSERT INTO collection_items (collection_id, item_id, position) VALUES (@collectionId, @itemId, @position)`,
  ).run({
    collectionId: input.collectionId,
    itemId: input.itemId,
    position: input.position ?? null,
  });
}

function fakeCoordinator(): IngestionCoordinator {
  return {
    start: () => {},
    cancel: () => false,
    disposeAll: () => {},
    active: () => [],
  };
}

const resolveMediaBinaries = () => ({ ffmpegPath: '/bin/ffmpeg', ffprobePath: '/bin/ffprobe' });

describe('CatalogRepo — listCollections / getCollection (#437 collections browser view)', () => {
  let db: Db;
  let repo: CatalogRepo;

  beforeEach(() => {
    db = freshCatalog();
    repo = createCatalogRepo(db);
  });
  afterEach(() => db.close());

  describe('listCollections', () => {
    it('lists user and suggested collections with their member counts, name-ordered', () => {
      const beachId = repo.insertItem({ mediaType: 'photo', contentHash: 'h1' });
      const mountainId = repo.insertItem({ mediaType: 'photo', contentHash: 'h2' });
      insertCollection(db, { id: 'col-zebra', name: 'Zebra memories', origin: 'user' });
      insertCollection(db, { id: 'col-alpha', name: 'Alpha memories', origin: 'suggested' });
      insertCollectionItem(db, { collectionId: 'col-zebra', itemId: beachId });
      insertCollectionItem(db, { collectionId: 'col-zebra', itemId: mountainId });
      insertCollectionItem(db, { collectionId: 'col-alpha', itemId: beachId });

      const collections = repo.listCollections();

      expect(collections.map((c) => c.name)).toEqual(['Alpha memories', 'Zebra memories']);
      const zebra = collections.find((c) => c.id === 'col-zebra');
      expect(zebra?.itemCount).toBe(2);
      const alpha = collections.find((c) => c.id === 'col-alpha');
      expect(alpha?.itemCount).toBe(1);
    });

    it('excludes dismissed tombstone collections — they are never browsable', () => {
      insertCollection(db, { id: 'col-real', name: 'A real collection', origin: 'user' });
      insertCollection(db, { id: 'col-gone', name: 'A dismissed suggestion', origin: 'dismissed' });

      const collections = repo.listCollections();

      expect(collections.map((c) => c.id)).toEqual(['col-real']);
    });

    it('returns an empty list when there are no collections yet', () => {
      expect(repo.listCollections()).toEqual([]);
    });
  });

  describe('getCollection', () => {
    it('returns the collection summary plus an offset-paginated page of members', () => {
      const ids = ['m1', 'm2', 'm3'].map((hash) =>
        repo.insertItem({ mediaType: 'photo', contentHash: hash }),
      );
      insertCollection(db, { id: 'col-1', name: 'A summer by the lake', origin: 'user' });
      ids.forEach((itemId, i) => insertCollectionItem(db, { collectionId: 'col-1', itemId, position: i }));

      const page1 = repo.getCollection({ id: 'col-1', limit: 2, offset: 0 });
      expect(page1.collection).toMatchObject({ id: 'col-1', name: 'A summer by the lake', itemCount: 3 });
      expect(page1.rows).toHaveLength(2);
      expect(page1.total).toBe(3);

      const page2 = repo.getCollection({ id: 'col-1', limit: 2, offset: 2 });
      expect(page2.rows).toHaveLength(1);
      // Together the two pages cover every member exactly once, position-ordered.
      expect([...page1.rows, ...page2.rows].map((r) => r.id)).toEqual(ids);
    });

    it('returns a null collection for an unknown id (never a throw at the repo layer)', () => {
      const result = repo.getCollection({ id: 'does-not-exist', limit: 10, offset: 0 });
      expect(result.collection).toBeNull();
      expect(result.rows).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('returns a null collection for a dismissed tombstone id — never browsable', () => {
      insertCollection(db, { id: 'col-gone', name: 'A dismissed suggestion', origin: 'dismissed' });
      const result = repo.getCollection({ id: 'col-gone', limit: 10, offset: 0 });
      expect(result.collection).toBeNull();
    });
  });
});

describe('createCatalogSession — listCollections / getCollection (#437, the IPC application service)', () => {
  let parent: string;
  let root: string;
  let session: ReturnType<typeof createCatalogSession>;

  beforeEach(() => {
    parent = makeTmpDir('collections-session');
    root = join(parent, 'Elena');
    session = createCatalogSession({ coordinator: fakeCoordinator(), resolveMediaBinaries });
  });
  afterEach(() => {
    session.dispose();
    removeTmpDir(parent);
  });

  function seedCollection(catalogPath: string): { collectionId: string; itemId: string } {
    const db = openCatalog(catalogPath);
    const repo = createCatalogRepo(db);
    const itemId = repo.insertItem({
      mediaType: 'photo',
      contentHash: 'h-seed',
      title: 'A quiet afternoon',
    });
    insertCollection(db, { id: 'col-seed', name: 'A quiet season', origin: 'user' });
    insertCollectionItem(db, { collectionId: 'col-seed', itemId });
    db.close();
    return { collectionId: 'col-seed', itemId };
  }

  it('refuses collections reads when no library is open', () => {
    expect(() => session.listCollections()).toThrow();
    expect(() => session.getCollection({ id: 'col-seed', limit: 10, offset: 0 })).toThrow();
  });

  it('lists collections as renderer-safe summaries', () => {
    session.createLibrary({ path: root });
    seedCollection(join(root, 'catalog.sqlite3'));

    const view = session.listCollections();

    expect(view.collections).toHaveLength(1);
    expect(view.collections[0]).toMatchObject({
      id: 'col-seed',
      name: 'A quiet season',
      itemCount: 1,
    });
  });

  it('fetches one collection with its members projected as renderer-safe ItemCards', () => {
    session.createLibrary({ path: root });
    seedCollection(join(root, 'catalog.sqlite3'));

    const page = session.getCollection({ id: 'col-seed', limit: 10, offset: 0 });

    expect(page.collection).toMatchObject({ id: 'col-seed', name: 'A quiet season', itemCount: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.title).toBe('A quiet afternoon');
    expect(page.items[0]).not.toHaveProperty('contentHash');
    expect(page.total).toBe(1);
  });

  it('throws for an unknown collection id (never silently ignored, mirrors getTranscript)', () => {
    session.createLibrary({ path: root });
    expect(() => session.getCollection({ id: 'no-such-collection', limit: 10, offset: 0 })).toThrow();
  });
});
