// AC-30 integration test (T-M4-2h / #270): given a real catalog carrying EXIF GPS
// AND stored embeddings, running categorization through the per-library port (with
// the deterministic INLINE cluster transport — no worker thread spawned) produces
// EXPLAINABLE place + theme assignments with concrete resolved provenance, and a
// user correction (confirm / reassign / remove) SURVIVES both a re-cluster and a
// "relaunch" (a fresh port over the same on-disk state). Also pins the default-off
// invariant (AC-33): opted-out, a run refuses with no side effects and the browse
// read is byte-identical — no chips, no category_status transitions.
//
// The port is exercised against a REAL in-memory better-sqlite3 catalog (NO DB
// mocking) with the real leaf collaborators (categories repo, gazetteer, cluster
// passes) — the same shape the production main process wires, minus Electron.

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';

import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo } from '../../electron/main/db/catalog-repo';
import { createEmbeddingsRepo } from '../../electron/main/db/embeddings-repo';
import { createCategoriesRepo } from '../../electron/main/categorize/categories-repo';
import { EMBED_DIM, EMBED_MODEL_ID } from '../../electron/main/search/embed-cli';
import { createGazetteer, type GazetteerEntry } from '../../electron/main/categorize/gazetteer';
import { createInlineClusterTransport } from '../../electron/main/categorize/categorization-worker';
import { resolveCategorizationStatus } from '../../electron/main/categorize/categorization-orchestrator';
import { createCategorizationLibraryPort } from '../../electron/main/categorize/categorization-library';

/** Narrow a `.find()` result without a non-null assertion (lint-clean, and a miss fails loudly). */
function requireDefined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected value to be defined');
  }
  return value;
}

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

function vec(fill: number): Float32Array {
  return Float32Array.from({ length: EMBED_DIM }, () => fill);
}

const CUSCO: GazetteerEntry = {
  id: 3941584,
  name: 'Cusco',
  lat: -13.5319,
  lon: -71.9675,
  admin1: '08',
  country: 'PE',
};
const GAZETTEER = createGazetteer([CUSCO]);

// Three photos a few metres apart, all effectively "at" Cusco → one place cluster.
const PLACE_ITEMS = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', lat: -13.532, lon: -71.9675 },
  { id: 'aaaaaaaa-0000-4000-8000-000000000002', lat: -13.5325, lon: -71.968 },
  { id: 'aaaaaaaa-0000-4000-8000-000000000003', lat: -13.5318, lon: -71.967 },
];
// Two message items sharing a vector → one theme cluster.
const THEME_ITEMS = [
  { id: 'bbbbbbbb-0000-4000-8000-000000000001', text: 'birthday cake with the family' },
  { id: 'bbbbbbbb-0000-4000-8000-000000000002', text: 'family birthday party' },
];

function seedCorpus(db: Db): void {
  const catalog = createCatalogRepo(db);
  const embeddings = createEmbeddingsRepo(db);
  for (const p of PLACE_ITEMS) {
    catalog.insertItem({ id: p.id, mediaType: 'photo', gpsLat: p.lat, gpsLon: p.lon });
  }
  for (const t of THEME_ITEMS) {
    catalog.insertItem({ id: t.id, mediaType: 'message', description: t.text });
    embeddings.upsertEmbedding(t.id, EMBED_MODEL_ID, vec(0.5));
  }
}

function makePort(db: Db, optedIn: boolean) {
  return createCategorizationLibraryPort({
    db,
    gazetteer: GAZETTEER,
    transport: createInlineClusterTransport(),
    getStatus: () =>
      resolveCategorizationStatus({ optedIn, placesAvailable: true, themesAvailable: true }),
    // Relaxed thresholds so the small fixtures still form clusters.
    placesOptions: { epsMeters: 2000, minPts: 2 },
    themesOptions: { minClusterSize: 2 },
  });
}

function categoryStatusOf(db: Db, id: string): string {
  return (
    db
      .prepare('SELECT category_status FROM items WHERE id = ?')
      .get<{ category_status: string }>(id)?.category_status ?? ''
  );
}

/**
 * Reset the given items' `category_status` back to `'pending'` so the next
 * `port.start()` call genuinely re-runs the clustering pass (drains them
 * through `assignAuto`) rather than being a no-op idle run.  Used by the
 * re-cluster durability tests to make them discriminating: a clobber mutation
 * that deletes `source='user'` rows would flip the assertions.
 */
function resetToPending(db: Db, ids: string[]): void {
  const stmt = db.prepare("UPDATE items SET category_status = 'pending' WHERE id = ?");
  for (const id of ids) stmt.run(id);
}

describe('AC-30 — explainable place + theme assignments (inline transport, no worker thread)', () => {
  it('produces a place chip with concrete GPS provenance (signal / confidence / explanation)', async () => {
    const db = freshCatalog();
    seedCorpus(db);
    const port = makePort(db, true);

    const result = await port.start();
    expect(result.outcome).toBe('completed');

    const chips = port.listForItem(PLACE_ITEMS[0].id);
    const place = chips.find((c) => c.kind === 'place');
    expect(place).toBeDefined();
    expect(place?.source).toBe('auto');
    expect(place?.signal).toBe('gps');
    expect(place?.confidence).toBe(0.9);
    expect(place?.explanation).toContain('Cusco');
    expect(place?.explanation).toContain('photo GPS');
  });

  it('produces a theme chip with theme-cluster provenance', async () => {
    const db = freshCatalog();
    seedCorpus(db);
    const port = makePort(db, true);

    await port.start();

    const chips = port.listForItem(THEME_ITEMS[0].id);
    const theme = chips.find((c) => c.kind === 'theme');
    expect(theme).toBeDefined();
    expect(theme?.signal).toBe('theme-cluster');
    expect(theme?.source).toBe('auto');
  });

  it('marks clustered items done and leaves the run counts tallied', async () => {
    const db = freshCatalog();
    seedCorpus(db);
    const port = makePort(db, true);

    const result = await port.start();

    expect(result.counts.categorized).toBeGreaterThan(0);
    expect(categoryStatusOf(db, PLACE_ITEMS[0].id)).toBe('done');
  });
});

describe('AC-30 — a user correction survives a re-cluster AND a relaunch (provenance durability)', () => {
  it('a REMOVE tombstone is not resurrected by a second clustering pass', async () => {
    const db = freshCatalog();
    seedCorpus(db);
    const port = makePort(db, true);
    await port.start();

    const place = requireDefined(
      port.listForItem(PLACE_ITEMS[0].id).find((c) => c.kind === 'place'),
    );
    port.applyCorrection({
      kind: 'remove',
      itemId: PLACE_ITEMS[0].id,
      categoryId: place.categoryId,
    });

    // Reset ALL place items to 'pending' so the second start() genuinely re-runs
    // the cluster pass (minPts=2 needs ≥2 GPS points in the pending corpus).
    // Without this reset, start() is an idle no-op and assignAuto is never called,
    // making the test non-discriminating for user-row clobber regressions.
    resetToPending(
      db,
      PLACE_ITEMS.map((p) => p.id),
    );

    // A second full run (re-cluster) must not resurrect the removed membership.
    await port.start();

    expect(port.listForItem(PLACE_ITEMS[0].id).some((c) => c.categoryId === place.categoryId)).toBe(
      false,
    );
  });

  it('a CONFIRM survives a relaunch — a FRESH port over the same DB still reads source=user', async () => {
    const db = freshCatalog();
    seedCorpus(db);
    const port = makePort(db, true);
    await port.start();

    const place = requireDefined(
      port.listForItem(PLACE_ITEMS[0].id).find((c) => c.kind === 'place'),
    );
    port.applyCorrection({
      kind: 'confirm',
      itemId: PLACE_ITEMS[0].id,
      categoryId: place.categoryId,
    });

    // Reset ALL place items to 'pending' so the relaunched port's start() genuinely
    // re-runs assignAuto on PLACE_ITEMS[0] (needs ≥2 GPS points for minPts=2).
    resetToPending(
      db,
      PLACE_ITEMS.map((p) => p.id),
    );

    // "Relaunch": a brand-new port instance over the SAME on-disk catalog, then re-run.
    const relaunched = makePort(db, true);
    await relaunched.start();

    const afterPlace = relaunched
      .listForItem(PLACE_ITEMS[0].id)
      .find((c) => c.categoryId === place.categoryId);
    expect(afterPlace?.source).toBe('user');
  });

  it('a REASSIGN survives a re-cluster (the user target stays, the auto source stays gone)', async () => {
    const db = freshCatalog();
    seedCorpus(db);
    const port = makePort(db, true);
    await port.start();

    const place = requireDefined(
      port.listForItem(PLACE_ITEMS[0].id).find((c) => c.kind === 'place'),
    );
    // Reassign onto a fresh user-made category (no source_key → never auto-collapsed).
    const targetId = createCategoriesRepo(db).upsertCategory({
      kind: 'place',
      name: 'Somewhere else',
    });
    port.applyCorrection({
      kind: 'reassign',
      itemId: PLACE_ITEMS[0].id,
      fromCategoryId: place.categoryId,
      toCategoryId: targetId,
    });

    // Reset ALL place items to 'pending' so start() re-runs assignAuto for
    // PLACE_ITEMS[0] and we can verify the user reassignment survives.
    resetToPending(
      db,
      PLACE_ITEMS.map((p) => p.id),
    );

    await port.start();

    const ids = port.listForItem(PLACE_ITEMS[0].id).map((c) => c.categoryId);
    expect(ids).toContain(targetId);
    expect(ids).not.toContain(place.categoryId);
  });
});

describe('AC-33 — default-off invariant: opted-out categorization is a calm no-op', () => {
  it('refuses the run with reason not-opted-in and makes NO side effects', async () => {
    const db = freshCatalog();
    seedCorpus(db);
    const catalog = createCatalogRepo(db);
    const before = catalog.queryTimeline({ limit: 50, cursor: null });

    const port = makePort(db, false);
    const result = await port.start();

    expect(result.outcome).toBe('refused');
    expect(result.reason).toBe('not-opted-in');
    // No chips for any item, and no category_status transitions (all still pending).
    for (const p of PLACE_ITEMS) {
      expect(port.listForItem(p.id)).toEqual([]);
      expect(categoryStatusOf(db, p.id)).toBe('pending');
    }
    // No category rows were created.
    expect(db.prepare('SELECT COUNT(*) AS n FROM categories').get<{ n: number }>()?.n).toBe(0);
    // Browse output is byte-identical to before the refused run (AC-6/AC-7/AC-29).
    const after = catalog.queryTimeline({ limit: 50, cursor: null });
    expect(after).toEqual(before);
  });
});
