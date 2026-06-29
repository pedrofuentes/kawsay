import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCatalog } from '../../electron/main/db/connection';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';
import {
  blobAbsPath,
  blobRelPath,
  garbageCollectOrphanedOriginals,
  putOriginal,
  removeOccurrence,
  resolveOriginal,
  verifyOriginalBlob,
} from '../../electron/main/library/originals-store';
import type { CatalogDatabase } from '../../electron/main/db/connection';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const BYTES_A = 'JPEG-BYTES';
const BYTES_B = 'bytes-b';
const BYTES_C = 'bytes-c';
const BYTES_D = 'bytes-d';
const HASH_A = createHash('sha256').update(BYTES_A).digest('hex');
const HASH_B = createHash('sha256').update(BYTES_B).digest('hex');
const HASH_C = createHash('sha256').update(BYTES_C).digest('hex');
const HASH_D = createHash('sha256').update(BYTES_D).digest('hex');
const BYTES_BY_HASH = new Map([
  [HASH_A, BYTES_A],
  [HASH_B, BYTES_B],
  [HASH_C, BYTES_C],
  [HASH_D, BYTES_D],
]);

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
    writeFileSync(incoming, BYTES_A);
    const put = putOriginal({ root, hash: HASH_A, ext: '.jpg', sourcePath: incoming });
    expect(put.copied).toBe(true);
    expect(put.absPath).toBe(blobAbsPath(root, HASH_A, '.jpg'));
    expect(readFileSync(put.absPath, 'utf8')).toBe(BYTES_A);
  });

  it('is idempotent — a second put with the same hash does not re-copy', () => {
    const incoming = join(root, 'incoming.jpg');
    const bytes = 'ORIGINAL';
    const hash = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(incoming, bytes);
    const first = putOriginal({ root, hash, ext: '.jpg', sourcePath: incoming });
    // Mutate the source; an idempotent put must NOT overwrite the stored blob.
    writeFileSync(incoming, 'CHANGED');
    const second = putOriginal({ root, hash, ext: '.jpg', sourcePath: incoming });
    expect(first.copied).toBe(true);
    expect(second.copied).toBe(false);
    expect(second.absPath).toBe(first.absPath);
    expect(readFileSync(first.absPath, 'utf8')).toBe('ORIGINAL');
  });

  it('refuses to reuse an existing blob whose bytes do not match the content hash', () => {
    const incoming = join(root, 'incoming.jpg');
    const bytes = 'correct';
    const hash = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(incoming, bytes);
    const put = putOriginal({ root, hash, ext: '.jpg', sourcePath: incoming });
    writeFileSync(put.absPath, 'corrupted');

    expect(() => putOriginal({ root, hash, ext: '.jpg', sourcePath: incoming })).toThrow(
      /ERR_ORIGINAL_INTEGRITY/,
    );
  });

  it('can verify a stored blob against its declared hash', () => {
    const content = Buffer.from('verified-by-sha');
    const hash = createHash('sha256').update(content).digest('hex');
    const incoming = join(root, 'verified.bin');
    writeFileSync(incoming, content);

    const put = putOriginal({ root, hash, ext: '.bin', sourcePath: incoming });

    expect(verifyOriginalBlob({ root, hash, ext: '.bin' })).toEqual({
      ok: true,
      absPath: put.absPath,
    });
  });

  it('rolls back a half-created destination when the copy fails', () => {
    const missing = join(root, 'missing.jpg');

    expect(() => putOriginal({ root, hash: HASH_B, ext: '.jpg', sourcePath: missing })).toThrow();
    expect(existsSync(blobAbsPath(root, HASH_B, '.jpg'))).toBe(false);
  });

  it('refuses to publish newly copied bytes under the wrong content hash', () => {
    const incoming = join(root, 'incoming.jpg');
    writeFileSync(incoming, 'not-the-declared-hash');

    expect(() => putOriginal({ root, hash: HASH_C, ext: '.jpg', sourcePath: incoming })).toThrow(
      /ERR_ORIGINAL_INTEGRITY/,
    );
    expect(existsSync(blobAbsPath(root, HASH_C, '.jpg'))).toBe(false);
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
    writeFileSync(incoming, BYTES_BY_HASH.get(hash) ?? hash);
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

  it('garbage-collects unreferenced blobs in keyset-sized batches', () => {
    const keptItem = repo.insertItem({ mediaType: 'photo', contentHash: HASH_A, originalExt: '.jpg' });
    repo.addOccurrence({
      itemId: keptItem,
      sourceId: sourceA,
      sourceRef: 'kept.jpg',
      originalKind: 'content_addressed',
    });
    const kept = stageBlob(HASH_A);
    const orphanB = stageBlob(HASH_B);
    const orphanC = stageBlob(HASH_C);

    const first = garbageCollectOrphanedOriginals(db, root, { limit: 1 });
    expect(first.scanned).toBe(1);
    expect(first.nextCursor).toBeTypeOf('string');
    expect(existsSync(kept)).toBe(true);

    const second = garbageCollectOrphanedOriginals(db, root, { limit: 10, afterHash: first.nextCursor });
    expect(first.deleted + second.deleted).toBe(2);
    expect(second.nextCursor).toBeNull();
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(orphanB)).toBe(false);
    expect(existsSync(orphanC)).toBe(false);
  });

  it('continues keyset GC across blobs that share a hash but have different extensions', () => {
    const incoming = join(root, 'incoming');
    writeFileSync(incoming, 'dup');
    const hash = createHash('sha256').update('dup').digest('hex');
    putOriginal({ root, hash, ext: '.jpg', sourcePath: incoming });
    putOriginal({ root, hash, ext: '.png', sourcePath: incoming });

    const first = garbageCollectOrphanedOriginals(db, root, { limit: 1 });
    const second = garbageCollectOrphanedOriginals(db, root, { limit: 1, afterHash: first.nextCursor });

    expect(first.deleted + second.deleted).toBe(2);
    expect(existsSync(blobAbsPath(root, hash, '.jpg'))).toBe(false);
    expect(existsSync(blobAbsPath(root, hash, '.png'))).toBe(false);
  });

  it('garbage-collects an unreferenced same-hash blob with a different extension', () => {
    const incoming = join(root, 'incoming-same-hash');
    writeFileSync(incoming, 'same-bytes');
    const hash = createHash('sha256').update('same-bytes').digest('hex');
    const referencedItem = repo.insertItem({ mediaType: 'photo', contentHash: hash, originalExt: '.jpg' });
    repo.addOccurrence({
      itemId: referencedItem,
      sourceId: sourceA,
      sourceRef: 'kept.jpg',
      originalKind: 'content_addressed',
    });
    putOriginal({ root, hash, ext: '.jpg', sourcePath: incoming });
    putOriginal({ root, hash, ext: '.png', sourcePath: incoming });

    const result = garbageCollectOrphanedOriginals(db, root);

    expect(result.deleted).toBe(1);
    expect(existsSync(blobAbsPath(root, hash, '.jpg'))).toBe(true);
    expect(existsSync(blobAbsPath(root, hash, '.png'))).toBe(false);
  });

  it('is a no-op for an unknown occurrence id', () => {
    expect(removeOccurrence(db, root, 'no-such-occurrence')).toEqual({
      removed: false,
      blobDeleted: false,
      itemRemoved: false,
    });
  });
});

// Archive filenames are attacker-controlled, so the hash/ext/asset-path that
// drive the content-addressed store can be hostile. The store is the AC-14 /
// ADR-0008 safety boundary: every copy/delete MUST stay inside the library root.
describe('originals store path confinement (security: AC-14 / ADR-0008)', () => {
  // The library lives one level under a tracked temp dir, so any escape lands
  // inside `base` and is still cleaned up by afterEach.
  let base: string;
  let root: string;
  let incoming: string;

  beforeEach(() => {
    base = makeTmpDir('originals-confine');
    root = join(base, 'lib');
    mkdirSync(root, { recursive: true });
    incoming = join(root, 'incoming.jpg');
    writeFileSync(incoming, 'JPEG-BYTES');
  });
  afterEach(() => removeTmpDir(base));

  it('rejects a content hash that is not a 64-char lowercase hex string', () => {
    const badHashes = [
      `../${'a'.repeat(61)}`, // traversal
      'g'.repeat(64), // non-hex
      'abc', // too short
      HASH_A.toUpperCase(), // not lowercase
      `${'a'.repeat(63)}\0`, // NUL byte
    ];
    for (const hash of badHashes) {
      expect(() => putOriginal({ root, hash, ext: '.jpg', sourcePath: incoming })).toThrow(
        /ERR_ORIGINAL_PATH_ESCAPE/,
      );
    }
  });

  it('rejects an extension containing a separator, traversal, or NUL', () => {
    const badExts = [
      '/../../../../etc/evil',
      '.jpg/../../../secret',
      '../evil',
      '.jp/g',
      '.jp\\g',
      '.jp\0g',
    ];
    for (const ext of badExts) {
      expect(() => putOriginal({ root, hash: HASH_A, ext, sourcePath: incoming })).toThrow(
        /ERR_ORIGINAL_PATH_ESCAPE/,
      );
    }
  });

  it('never copies a blob outside the library root when given a hostile ext', () => {
    const outside = join(base, 'escapee.jpg');
    expect(() =>
      putOriginal({ root, hash: HASH_A, ext: '/../../../../escapee.jpg', sourcePath: incoming }),
    ).toThrow(/ERR_ORIGINAL_PATH_ESCAPE/);
    expect(existsSync(outside)).toBe(false);
  });

  it('still stores and resolves a valid original (the safe path stays green)', () => {
    const put = putOriginal({ root, hash: HASH_A, ext: '.jpg', sourcePath: incoming });
    expect(put.copied).toBe(true);
    expect(put.absPath).toBe(blobAbsPath(root, HASH_A, '.jpg'));
    expect(existsSync(put.absPath)).toBe(true);
  });

  it('refuses to resolve a stored content_hash that would escape the root', () => {
    const db = openCatalog(join(root, 'catalog.sqlite3'));
    runMigrations(db);
    const repo = createCatalogRepo(db);
    const src = repo.registerSource({ sourceKey: 'X', type: 'whatsapp', label: 'WA' });
    const itemId = repo.insertItem({
      mediaType: 'photo',
      contentHash: '../../../../etc/passwd',
      originalExt: '.jpg',
    });
    repo.addOccurrence({
      itemId,
      sourceId: src,
      sourceRef: 'a/b.jpg',
      originalKind: 'content_addressed',
    });
    expect(() => resolveOriginal(db, root, itemId)).toThrow(/ERR_ORIGINAL_PATH_ESCAPE/);
    db.close();
  });

  it('refuses to delete a derived asset that escapes the root, leaving outside files intact', () => {
    const db = openCatalog(join(root, 'catalog.sqlite3'));
    runMigrations(db);
    const repo = createCatalogRepo(db);
    const src = repo.registerSource({ sourceKey: 'Y', type: 'whatsapp', label: 'WA' });

    const sentinel = join(base, 'sentinel.txt');
    writeFileSync(sentinel, 'SECRET');

    const itemId = repo.insertItem({ mediaType: 'photo', contentHash: HASH_A, originalExt: '.jpg' });
    const blob = putOriginal({ root, hash: HASH_A, ext: '.jpg', sourcePath: incoming }).absPath;
    // A surviving content-addressed blob is legitimate; only the asset path is hostile.
    repo.addAsset({ itemId, kind: 'thumbnail', path: join('..', 'sentinel.txt') });
    const occ = repo.addOccurrence({
      itemId,
      sourceId: src,
      sourceRef: 'a/b.jpg',
      originalKind: 'content_addressed',
    });

    expect(() => removeOccurrence(db, root, occ.id)).toThrow(/ERR_ORIGINAL_PATH_ESCAPE/);
    // The hostile undo is refused atomically — nothing outside (or the valid blob) is deleted.
    expect(existsSync(sentinel)).toBe(true);
    expect(existsSync(blob)).toBe(true);
    db.close();
  });
});
