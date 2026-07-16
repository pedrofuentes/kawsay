// Undo import (#429, AC-14 / P4b): source-scoped transactional removal. Undo is
// identified by the `sources.id` this import wrote its occurrences against — the
// EXISTING dedup-with-provenance schema (ADR-0003), so NO migration is needed. A
// single transaction deletes exactly this source's occurrences, drops the items
// left with no remaining occurrence (cascading FTS/embeddings/transcripts/
// categories/assets/tags), and — after commit — removes only the orphaned items'
// copied originals + derived renditions. An item that is ALSO in another source
// (deduped) survives untouched, and so does its file.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCatalog } from '../../electron/main/db/connection';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';
import {
  blobAbsPath,
  putOriginal,
  removeSource,
  resolveOriginal,
} from '../../electron/main/library/originals-store';
import type { CatalogDatabase } from '../../electron/main/db/connection';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const hashOf = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');

describe('removeSource (undo import — AC-14, dedup survivors preserved)', () => {
  let root: string;
  let db: CatalogDatabase;
  let repo: CatalogRepo;
  let sourceA: string;

  beforeEach(() => {
    root = makeTmpDir('undo-import');
    db = openCatalog(join(root, 'catalog.sqlite3'));
    runMigrations(db);
    repo = createCatalogRepo(db);
    // Source A is the PRE-IMPORT catalog: it must survive every undo of B.
    sourceA = repo.registerSource({ sourceKey: 'A', type: 'google_takeout', label: 'Takeout' });
  });
  afterEach(() => {
    db.close();
    removeTmpDir(root);
  });

  function stageBlob(hash: string, bytes: string): string {
    const incoming = join(root, `incoming-${hash.slice(0, 8)}`);
    writeFileSync(incoming, bytes);
    return putOriginal({ root, hash, ext: '.jpg', sourcePath: incoming }).absPath;
  }

  function count(sql: string): number {
    return Number((db.prepare(sql).get() as { n: number }).n);
  }
  function snapshot() {
    return {
      items: count('SELECT COUNT(*) AS n FROM items'),
      occurrences: count('SELECT COUNT(*) AS n FROM item_occurrences'),
      fts: count('SELECT COUNT(*) AS n FROM items_fts'),
      embeddings: count('SELECT COUNT(*) AS n FROM item_embeddings'),
      transcripts: count('SELECT COUNT(*) AS n FROM transcripts'),
      categories: count('SELECT COUNT(*) AS n FROM item_categories'),
      sources: count('SELECT COUNT(*) AS n FROM sources'),
    };
  }

  // Insert the derived rows an ingest + later runs attach to an item, so undo can be
  // proven to cascade them away (AC-14: undo also reclaims embeddings/transcripts/etc.).
  function attachDerived(itemId: string, hashHex: string): void {
    db.prepare(
      `INSERT INTO item_embeddings (item_id, kind, model_id, dim, vector)
       VALUES (@itemId, 'text', 'model-x', 2, @vector)`,
    ).run({ itemId, vector: Buffer.from(new Float32Array([0.5, 0.25]).buffer) });
    db.prepare(
      `INSERT INTO transcripts (item_id, text, language) VALUES (@itemId, 'hola', 'es')`,
    ).run({ itemId });
    const categoryId = `cat-${hashHex.slice(0, 8)}`;
    db.prepare(
      `INSERT INTO categories (id, kind, name) VALUES (@id, 'place', 'Cusco')`,
    ).run({ id: categoryId });
    db.prepare(
      `INSERT INTO item_categories (item_id, category_id, source, signal)
       VALUES (@itemId, @categoryId, 'auto', 'gps')`,
    ).run({ itemId, categoryId });
  }

  it('restores the catalog to its pre-import state (round-trip), sparing source A', () => {
    // Pre-import: one memory already in source A.
    const kept = repo.insertItem({ mediaType: 'photo', contentHash: hashOf('A'), originalExt: '.jpg', searchMeta: 'kept' });
    repo.addOccurrence({ itemId: kept, sourceId: sourceA, sourceRef: 'A/kept.jpg', originalKind: 'in_place', originalPath: join(root, 'kept.jpg') });
    const before = snapshot();

    // Import source B: a brand-new memory with a copied original + full derived rows.
    const sourceB = repo.registerSource({ sourceKey: 'B', type: 'whatsapp', label: 'WhatsApp' });
    const bHash = hashOf('B');
    const blob = stageBlob(bHash, 'B');
    const newItem = repo.insertItem({ mediaType: 'photo', contentHash: bHash, originalExt: '.jpg', searchMeta: 'new' });
    repo.addOccurrence({ itemId: newItem, sourceId: sourceB, sourceRef: 'B/new.jpg', originalKind: 'content_addressed' });
    const thumbRel = join('derived', 'thumbnails', bHash.slice(0, 2), `${bHash}.webp`);
    mkdirSync(join(root, 'derived', 'thumbnails', bHash.slice(0, 2)), { recursive: true });
    writeFileSync(join(root, thumbRel), 'WEBP');
    repo.addAsset({ itemId: newItem, kind: 'thumbnail', path: thumbRel });
    attachDerived(newItem, bHash);
    expect(snapshot()).not.toEqual(before);

    const result = removeSource(db, root, sourceB);

    expect(result).toMatchObject({ removed: true, occurrencesRemoved: 1, itemsRemoved: 1 });
    expect(snapshot()).toEqual(before); // exactly pre-import — every derived table too
    expect(existsSync(blob)).toBe(false); // the copied original is reclaimed
    expect(existsSync(join(root, thumbRel))).toBe(false); // its derived rendition too
    // Source A and its memory are untouched.
    expect(resolveOriginal(db, root, kept)).toBe(join(root, 'kept.jpg'));
  });

  it('preserves an item deduped into another source — only THIS import\'s occurrence goes', () => {
    // The shared bytes arrived first from A (pre-import) and again from B (this import).
    const shared = hashOf('shared');
    const blob = stageBlob(shared, 'shared');
    const itemId = repo.insertItem({ mediaType: 'photo', contentHash: shared, originalExt: '.jpg' });
    repo.addOccurrence({ itemId, sourceId: sourceA, sourceRef: 'A/shared.jpg', originalKind: 'content_addressed' });
    const sourceB = repo.registerSource({ sourceKey: 'B', type: 'whatsapp', label: 'WhatsApp' });
    repo.addOccurrence({ itemId, sourceId: sourceB, sourceRef: 'B/shared.jpg', originalKind: 'content_addressed' });

    const result = removeSource(db, root, sourceB);

    // The item SURVIVES with only A's occurrence, and its file is NOT deleted.
    expect(result).toMatchObject({ removed: true, occurrencesRemoved: 1, itemsRemoved: 0, blobsDeleted: 0 });
    expect(count('SELECT COUNT(*) AS n FROM items')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM item_occurrences')).toBe(1);
    expect(existsSync(blob)).toBe(true);
    expect(resolveOriginal(db, root, itemId)).toBe(blob);
  });

  it('never deletes an in-place (folder) original, even when its item is removed', () => {
    const userFile = join(root, 'user.jpg');
    writeFileSync(userFile, 'USER');
    const sourceB = repo.registerSource({ sourceKey: 'B', type: 'folder', label: 'Folder' });
    const itemId = repo.insertItem({ mediaType: 'photo', contentHash: hashOf('user'), originalExt: '.jpg' });
    repo.addOccurrence({ itemId, sourceId: sourceB, sourceRef: 'B/user.jpg', originalKind: 'in_place', originalPath: userFile });

    const result = removeSource(db, root, sourceB);

    expect(result.itemsRemoved).toBe(1);
    expect(existsSync(userFile)).toBe(true); // the user's own file is sacred
  });

  it('supports an idempotent re-import after undo (brings the very same memory back)', () => {
    const sourceB = repo.registerSource({ sourceKey: 'B', type: 'whatsapp', label: 'WhatsApp' });
    const bHash = hashOf('reimport');
    stageBlob(bHash, 'reimport');
    const first = repo.insertItem({ mediaType: 'photo', contentHash: bHash, originalExt: '.jpg' });
    repo.addOccurrence({ itemId: first, sourceId: sourceB, sourceRef: 'B/x.jpg', originalKind: 'content_addressed' });

    removeSource(db, root, sourceB);
    expect(count('SELECT COUNT(*) AS n FROM items')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM sources')).toBe(0);

    // Re-import: registering the same source_key mints a fresh source and re-adds it.
    const reB = repo.registerSource({ sourceKey: 'B', type: 'whatsapp', label: 'WhatsApp' });
    stageBlob(bHash, 'reimport');
    const again = repo.insertItem({ mediaType: 'photo', contentHash: bHash, originalExt: '.jpg' });
    const occ = repo.addOccurrence({ itemId: again, sourceId: reB, sourceRef: 'B/x.jpg', originalKind: 'content_addressed' });
    expect(occ.inserted).toBe(true);
    expect(count('SELECT COUNT(*) AS n FROM items')).toBe(1);
  });

  it('is all-or-nothing: an error mid-removal rolls back, leaving NO partial state', () => {
    const sourceB = repo.registerSource({ sourceKey: 'B', type: 'whatsapp', label: 'WhatsApp' });
    const itemId = repo.insertItem({ mediaType: 'photo', contentHash: hashOf('bad'), originalExt: '.jpg' });
    repo.addOccurrence({ itemId, sourceId: sourceB, sourceRef: 'B/bad.jpg', originalKind: 'content_addressed' });
    // A malicious/corrupt derived path forces a path-escape throw INSIDE the removal
    // transaction, after occurrences would have been deleted — proving the rollback.
    repo.addAsset({ itemId, kind: 'thumbnail', path: join('..', 'escape.webp') });
    const before = snapshot();

    expect(() => removeSource(db, root, sourceB)).toThrow(/ERR_ORIGINAL_PATH_ESCAPE/);

    // Nothing was removed — the occurrence, item, and source all remain.
    expect(snapshot()).toEqual(before);
  });

  it('returns removed:false and touches nothing for an unknown source id', () => {
    const before = snapshot();
    const result = removeSource(db, root, 'no-such-source');
    expect(result).toMatchObject({ removed: false, occurrencesRemoved: 0, itemsRemoved: 0 });
    expect(snapshot()).toEqual(before);
  });
});
