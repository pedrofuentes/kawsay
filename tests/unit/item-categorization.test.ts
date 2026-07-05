// Unit tests for the item-categorization read/correction service (T-M4-2h / #270).
// Mirrors the categories-repo test style: a REAL in-memory better-sqlite3 catalog
// with migrations applied (NO DB mocking), real leaf collaborators (categories
// repo), and discriminating oracles — concrete resolved provenance (source / signal
// / confidence / explanation), not merely "it listed something". The service is the
// renderer's read path (per-item chips) and its correction path (confirm / reassign
// / remove / rename), so USER-WINS precedence and tombstone hiding are asserted.

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';

import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo } from '../../electron/main/db/catalog-repo';
import { createCategoriesRepo } from '../../electron/main/categorize/categories-repo';
import { createItemCategorizationService } from '../../electron/main/categorize/item-categorization';

const openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function freshCatalog(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  openDbs.push(db);
  return db;
}

const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';

/** Seed one item and two auto-assigned categories (a place + a theme). */
function seedItemWithTwoCategories(db: Db): { placeId: string; themeId: string } {
  const catalog = createCatalogRepo(db);
  const categories = createCategoriesRepo(db);
  catalog.insertItem({ id: ITEM_A, mediaType: 'photo', gpsLat: -13.53, gpsLon: -71.96 });
  catalog.insertItem({ id: ITEM_B, mediaType: 'photo' });
  const placeId = categories.upsertCategory({
    kind: 'place',
    name: 'Cusco, PE',
    sourceKey: 'place:3941584',
  });
  const themeId = categories.upsertCategory({
    kind: 'theme',
    name: 'Beach days',
    sourceKey: 'theme:abc123',
  });
  categories.assignAuto({
    itemId: ITEM_A,
    categoryId: placeId,
    signal: 'gps',
    confidence: 0.9,
    explanation: 'Near Cusco, PE (from photo GPS)',
  });
  categories.assignAuto({
    itemId: ITEM_A,
    categoryId: themeId,
    signal: 'theme-cluster',
    confidence: 0.8,
    explanation: 'Grouped with 4 similar items — Beach days',
  });
  return { placeId, themeId };
}

describe('createItemCategorizationService — listForItem (the renderer chip read)', () => {
  it('resolves an item’s auto assignments with concrete provenance, sorted by kind then name', () => {
    const db = freshCatalog();
    const { placeId, themeId } = seedItemWithTwoCategories(db);
    const service = createItemCategorizationService(db);

    const list = service.listForItem(ITEM_A);

    // Sorted place-before-theme (kind order), each carrying its full provenance.
    expect(list).toEqual([
      {
        categoryId: placeId,
        kind: 'place',
        name: 'Cusco, PE',
        source: 'auto',
        signal: 'gps',
        confidence: 0.9,
        explanation: 'Near Cusco, PE (from photo GPS)',
      },
      {
        categoryId: themeId,
        kind: 'theme',
        name: 'Beach days',
        source: 'auto',
        signal: 'theme-cluster',
        confidence: 0.8,
        explanation: 'Grouped with 4 similar items — Beach days',
      },
    ]);
  });

  it('returns an empty list for an item with no assignments', () => {
    const db = freshCatalog();
    seedItemWithTwoCategories(db);
    const service = createItemCategorizationService(db);

    expect(service.listForItem(ITEM_B)).toEqual([]);
  });

  it('lets a USER row win over the coexisting auto row (source reads as user)', () => {
    const db = freshCatalog();
    const { placeId } = seedItemWithTwoCategories(db);
    createCategoriesRepo(db).setUserAssignment({ itemId: ITEM_A, categoryId: placeId });
    const service = createItemCategorizationService(db);

    const place = service.listForItem(ITEM_A).find((c) => c.categoryId === placeId);
    expect(place?.source).toBe('user');
  });

  it('HIDES a category the user removed (a tombstone), leaving the others', () => {
    const db = freshCatalog();
    const { placeId, themeId } = seedItemWithTwoCategories(db);
    createCategoriesRepo(db).setUserAssignment({
      itemId: ITEM_A,
      categoryId: placeId,
      state: 'removed',
    });
    const service = createItemCategorizationService(db);

    const ids = service.listForItem(ITEM_A).map((c) => c.categoryId);
    expect(ids).toEqual([themeId]);
  });
});

describe('createItemCategorizationService — applyCorrection (confirm / remove / reassign / rename)', () => {
  it('confirm: writes a user assigned row and returns the refreshed list (source=user)', () => {
    const db = freshCatalog();
    const { placeId } = seedItemWithTwoCategories(db);
    const service = createItemCategorizationService(db);

    const refreshed = service.applyCorrection({
      kind: 'confirm',
      itemId: ITEM_A,
      categoryId: placeId,
    });

    expect(refreshed.find((c) => c.categoryId === placeId)?.source).toBe('user');
  });

  it('remove: tombstones the membership so it disappears from the list', () => {
    const db = freshCatalog();
    const { placeId, themeId } = seedItemWithTwoCategories(db);
    const service = createItemCategorizationService(db);

    const refreshed = service.applyCorrection({
      kind: 'remove',
      itemId: ITEM_A,
      categoryId: placeId,
    });

    expect(refreshed.map((c) => c.categoryId)).toEqual([themeId]);
  });

  it('reassign: removes the old category and assigns the new one atomically', () => {
    const db = freshCatalog();
    const { placeId, themeId } = seedItemWithTwoCategories(db);
    const categories = createCategoriesRepo(db);
    const otherPlaceId = categories.upsertCategory({
      kind: 'place',
      name: 'Lima, PE',
      sourceKey: 'place:3936456',
    });
    const service = createItemCategorizationService(db);

    const refreshed = service.applyCorrection({
      kind: 'reassign',
      itemId: ITEM_A,
      fromCategoryId: placeId,
      toCategoryId: otherPlaceId,
    });

    const ids = refreshed.map((c) => c.categoryId).sort();
    expect(ids).toEqual([otherPlaceId, themeId].sort());
    expect(refreshed.find((c) => c.categoryId === otherPlaceId)?.source).toBe('user');
    expect(refreshed.some((c) => c.categoryId === placeId)).toBe(false);
  });

  it('rename: updates the category name shown for the item', () => {
    const db = freshCatalog();
    const { placeId } = seedItemWithTwoCategories(db);
    const service = createItemCategorizationService(db);

    const refreshed = service.applyCorrection({
      kind: 'rename',
      itemId: ITEM_A,
      categoryId: placeId,
      name: 'Cusco, Perú',
    });

    expect(refreshed.find((c) => c.categoryId === placeId)?.name).toBe('Cusco, Perú');
    // The rename is durable on the category row itself.
    expect(createCategoriesRepo(db).getCategory(placeId)?.name).toBe('Cusco, Perú');
  });
});
