import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCatalog } from '../../electron/main/db/connection';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';
import {
  blobAbsPath,
  blobRelPath,
  putOriginal,
  removeOccurrence,
  resolveOriginal,
} from '../../electron/main/library/originals-store';
import type { CatalogDatabase } from '../../electron/main/db/connection';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

describe('content-addressed blob paths', () => {
  it('shards by the first two hex characters and appends the original extension', () => {
    expect(blobRelPath('abcd1234', '.jpg')).toBe(join('originals', 'ab', 'abcd1234.jpg'));
    expect(blobAbsPath('/lib', 'abcd1234', '.jpg')).toBe(
      join('/lib', 'originals', 'ab', 'abcd1234.jpg'),
    );
  });
  it('normalizes a missing dot and tolerates no extension', () => {
    expect(blobRelPath('ff00aa', 'png')).toBe(join('originals', 'ff', 'ff00aa.png'));
    expect(blobRelPath('beef00')).toBe(join('originals', 'be', 'beef00'));
  });
});

describe('putOriginal (store once, content-addressed)', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('originals-put');
  });
  afterEach(() => removeTmpDir(root));

  it('copies the bytes into the sharded blob path on first call', () => {
    const incoming = join(root, 'incoming.jpg');
    writeFileSync(incoming, 'JPEG-BYTES');
    const put = putOriginal({ root, hash: HASH_A, ext: '.jpg', sourcePath: incoming });
    expect(put.copied).toBe(true);
    expect(put.absPath).toBe(blobAbsPath(root, HASH_A, '.jpg'));
    expect(readFileSync(put.absPath, 'utf8')).toBe('JPEG-BYTES');
  });

  it('is idempotent — a second put with the same hash does not re-copy', () => {
    const incoming = join(root, 'incoming.jpg');
    writeFileSync(incoming, 'ORIGINAL');
    const first = putOriginal({ root, hash: HASH_A, ext: '.jpg', sourcePath: incoming });
    // Mutate the source; an idempotent put must NOT overwrite the stored blob.
    writeFileSync(incoming, 'CHANGED');
    const second = putOriginal({ root, hash: HASH_A, ext: '.jpg', sourcePath: incoming });
    expect(first.copied).toBe(true);
    expect(second.copied).toBe(false);
    expect(second.absPath).toBe(first.absPath);
    expect(readFileSync(first.absPath, 'utf8')).toBe('ORIGINAL');
  });
});

describe('originals reference-counting (AC-14: never dangle)', () => {
  let root: string;
  let db: CatalogDatabase;
  let repo: CatalogRepo;
  let sourceA: string;
  let sourceB: string;

  beforeEach(() => {
    root = makeTmpDir('originals-rc');
    db = openCatalog(join(root, 'catalog.sqlite3'));
    runMigrations(db);
    repo = createCatalogRepo(db);
    sourceA = repo.registerSource({ sourceKey: 'A', type: 'google_takeout', label: 'Takeout' });
    sourceB = repo.registerSource({ sourceKey: 'B', type: 'whatsapp', label: 'WhatsApp' });
  });
  afterEach(() => {
    db.close();
    removeTmpDir(root);
  });

  function stageBlob(hash: string): string {
    const incoming = join(root, `incoming-${hash.slice(0, 6)}.jpg`);
    writeFileSync(incoming, `bytes-${hash.slice(0, 6)}`);
    return putOriginal({ root, hash, ext: '.jpg', sourcePath: incoming }).absPath;
  }

  it('resolves a content-addressed item to its blob, and an undated message to null', () => {
    const itemId = repo.insertItem({ mediaType: 'photo', contentHash: HASH_A, originalExt: '.jpg' });
    const blob = stageBlob(HASH_A);
    repo.addOccurrence({
      itemId,
      sourceId: sourceA,
      sourceRef: 'Takeout/IMG.jpg',
      originalKind: 'content_addressed',
    });
    expect(resolveOriginal(db, root, itemId)).toBe(blob);

    const messageId = repo.insertItem({ mediaType: 'message', description: 'hola' });
    repo.addOccurrence({ itemId: messageId, sourceId: sourceB, sourceRef: 'chat#1', originalKind: 'none' });
    expect(resolveOriginal(db, root, messageId)).toBeNull();
  });

  it('keeps the shared blob until the LAST content-addressed occurrence is removed', () => {
    const itemId = repo.insertItem({ mediaType: 'photo', contentHash: HASH_A, originalExt: '.jpg' });
    const blob = stageBlob(HASH_A);
    const occA = repo.addOccurrence({
      itemId,
      sourceId: sourceA,
      sourceRef: 'Takeout/IMG.jpg',
      originalKind: 'content_addressed',
    });
    const occB = repo.addOccurrence({
      itemId,
      sourceId: sourceB,
      sourceRef: 'WhatsApp/IMG.jpg',
      originalKind: 'content_addressed',
    });

    // Removing source A must NOT delete the blob — source B still references it.
    const afterA = removeOccurrence(db, root, occA.id);
    expect(afterA).toEqual({ removed: true, blobDeleted: false, itemRemoved: false });
    expect(existsSync(blob)).toBe(true);
    expect(resolveOriginal(db, root, itemId)).toBe(blob);

    // Removing the last occurrence drops the blob AND the now-orphaned item.
    const afterB = removeOccurrence(db, root, occB.id);
    expect(afterB).toEqual({ removed: true, blobDeleted: true, itemRemoved: true });
    expect(existsSync(blob)).toBe(false);
    expect(resolveOriginal(db, root, itemId)).toBeNull();
  });

  it('never deletes an in-place (folder) original, even when its item is removed', () => {
    const userFile = join(root, 'user-photo.jpg');
    writeFileSync(userFile, 'USER-BYTES');
    const itemId = repo.insertItem({ mediaType: 'photo', contentHash: HASH_C, originalExt: '.jpg' });
    const occ = repo.addOccurrence({
      itemId,
      sourceId: sourceA,
      sourceRef: 'folder/user-photo.jpg',
      originalKind: 'in_place',
      originalPath: userFile,
    });
    expect(resolveOriginal(db, root, itemId)).toBe(userFile);

    const result = removeOccurrence(db, root, occ.id);
    expect(result.removed).toBe(true);
    expect(result.itemRemoved).toBe(true);
    expect(existsSync(userFile)).toBe(true);
  });

  it('prefers an in-place original and keeps the item while in-place survives a blob removal', () => {
    const userFile = join(root, 'folder-copy.jpg');
    writeFileSync(userFile, 'FOLDER');
    const itemId = repo.insertItem({ mediaType: 'photo', contentHash: HASH_D, originalExt: '.jpg' });
    const blob = stageBlob(HASH_D);
    const occCa = repo.addOccurrence({
      itemId,
      sourceId: sourceA,
      sourceRef: 'Takeout/IMG.jpg',
      originalKind: 'content_addressed',
    });
    repo.addOccurrence({
      itemId,
      sourceId: sourceB,
      sourceRef: 'folder/folder-copy.jpg',
      originalKind: 'in_place',
      originalPath: userFile,
    });
    expect(resolveOriginal(db, root, itemId)).toBe(userFile);

    const result = removeOccurrence(db, root, occCa.id);
    expect(result.blobDeleted).toBe(true);
    expect(result.itemRemoved).toBe(false);
    expect(existsSync(blob)).toBe(false);
    expect(existsSync(userFile)).toBe(true);
    expect(resolveOriginal(db, root, itemId)).toBe(userFile);
  });

  it('deletes orphaned derived renditions when the last occurrence is removed', () => {
    const itemId = repo.insertItem({ mediaType: 'photo', contentHash: HASH_B, originalExt: '.jpg' });
    const thumbRel = join('derived', 'thumbnails', 'bb', `${HASH_B}.webp`);
    const thumbAbs = join(root, thumbRel);
    mkdirSync(join(root, 'derived', 'thumbnails', 'bb'), { recursive: true });
    writeFileSync(thumbAbs, 'WEBP');
    repo.addAsset({ itemId, kind: 'thumbnail', path: thumbRel });
    const occ = repo.addOccurrence({
      itemId,
      sourceId: sourceA,
      sourceRef: 'Takeout/IMG.jpg',
      originalKind: 'content_addressed',
    });

    const result = removeOccurrence(db, root, occ.id);
    expect(result.itemRemoved).toBe(true);
    expect(existsSync(thumbAbs)).toBe(false);
  });

  it('is a no-op for an unknown occurrence id', () => {
    expect(removeOccurrence(db, root, 'no-such-occurrence')).toEqual({
      removed: false,
      blobDeleted: false,
      itemRemoved: false,
    });
  });
});
