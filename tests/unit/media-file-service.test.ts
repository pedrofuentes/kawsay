// Unit tests for the id→confined-path media resolver behind the `kawsay-media:`
// protocol (#428). Mirrors the thumbnail-service posture (U4 / AC-14): the
// renderer names ONLY an opaque catalog id, and the service resolves it
// server-side to a path CONFINED to the library originals via `resolveOriginal`,
// which THROWS on an escaping content-address rather than reading outside the
// store. No renderer-supplied path is ever accepted, and the whole path is
// egress-free (AC-4).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCatalog, type CatalogDatabase } from '../../electron/main/db/connection';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';
import {
  blobAbsPath,
  ERR_ORIGINAL_PATH_ESCAPE,
  isServablePath,
} from '../../electron/main/library/originals-store';
import { createMediaFileService } from '../../electron/main/library/media-file-service';
import { createMediaProtocolHandler } from '../../electron/main/security/media-protocol';
import { mediaUrl } from '@shared/media';
import type { MediaType } from '@shared/catalog';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';
import { installEgressSpies } from '../ac4/egress-spies';

/** Request headers stand-in with no Range (a full serve). */
function noRangeHeaders(): { get(name: string): string | null } {
  return { get: () => null };
}

/** A canonical 64-hex content hash seeded from a single distinguishing nibble. */
function hash(nibble: string): string {
  return nibble.repeat(64);
}

describe('createMediaFileService (id-keyed, path-confined media resolution — #428 / AC-14)', () => {
  let root: string;
  let db: CatalogDatabase;
  let repo: CatalogRepo;
  let sourceId: string;

  beforeEach(() => {
    root = makeTmpDir('media-svc');
    db = openCatalog(join(root, 'catalog.sqlite3'));
    runMigrations(db);
    repo = createCatalogRepo(db);
    sourceId = repo.registerSource({ sourceKey: 'seed', type: 'folder', label: 'Seed' });
  });
  afterEach(() => {
    db.close();
    removeTmpDir(root);
  });

  /** Seed an item with one occurrence and return its opaque catalog id. */
  function seedItem(
    mediaType: MediaType,
    opts: {
      contentHash?: string | null;
      mimeType?: string | null;
      originalExt?: string | null;
      kind?: 'content_addressed' | 'in_place' | 'none';
      path?: string;
    } = {},
  ): string {
    const id = repo.insertItem({
      mediaType,
      mimeType: opts.mimeType ?? null,
      contentHash: opts.contentHash ?? null,
      originalExt: opts.originalExt ?? '.bin',
    });
    repo.addOccurrence({
      itemId: id,
      sourceId,
      sourceRef: `ref/${id}`,
      originalKind: opts.kind ?? 'none',
      originalPath: opts.path ?? null,
    });
    return id;
  }

  it('resolves an audio memory by id to its CONFINED originals-store path (never a renderer path)', () => {
    const service = createMediaFileService({ db, root });
    const id = seedItem('audio', {
      contentHash: hash('a'),
      mimeType: 'audio/mpeg',
      originalExt: '.mp3',
      kind: 'content_addressed',
    });

    const descriptor = service.resolve(id);
    expect(descriptor).not.toBeNull();
    expect(descriptor?.absPath).toBe(blobAbsPath(root, hash('a'), '.mp3'));
    expect(descriptor?.mimeType).toBe('audio/mpeg');
    expect(descriptor?.mediaType).toBe('audio');
  });

  it('resolves a video memory by id', () => {
    const service = createMediaFileService({ db, root });
    const id = seedItem('video', {
      contentHash: hash('b'),
      mimeType: 'video/mp4',
      originalExt: '.mp4',
      kind: 'content_addressed',
    });
    expect(service.resolve(id)?.mediaType).toBe('video');
    expect(service.resolve(id)?.mimeType).toBe('video/mp4');
  });

  it('resolves a photo memory by id (images open full-size through the same protocol)', () => {
    const service = createMediaFileService({ db, root });
    const id = seedItem('photo', {
      contentHash: hash('c'),
      mimeType: 'image/jpeg',
      originalExt: '.jpg',
      kind: 'content_addressed',
    });
    expect(service.resolve(id)?.mediaType).toBe('photo');
    expect(service.resolve(id)?.mimeType).toBe('image/jpeg');
  });

  it('derives a sane content-type from the extension when the catalog stored none', () => {
    const service = createMediaFileService({ db, root });
    const id = seedItem('audio', {
      contentHash: hash('d'),
      mimeType: null,
      originalExt: '.m4a',
      kind: 'content_addressed',
    });
    expect(service.resolve(id)?.mimeType).toBe('audio/mp4');
  });

  it('returns null for non-playable media (document/message) WITHOUT resolving an original', () => {
    const service = createMediaFileService({ db, root });
    for (const mediaType of ['document', 'message'] as const) {
      const id = seedItem(mediaType, { contentHash: null, kind: 'none' });
      expect(service.resolve(id)).toBeNull();
    }
  });

  it('returns null for an unknown id (no row) without throwing', () => {
    const service = createMediaFileService({ db, root });
    expect(service.resolve('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('returns null when the memory has no surviving original', () => {
    const service = createMediaFileService({ db, root });
    const id = seedItem('audio', { contentHash: null, kind: 'none' });
    expect(service.resolve(id)).toBeNull();
  });

  it('REJECTS a stored content hash that would escape the library root (path containment)', () => {
    const service = createMediaFileService({ db, root });
    // A hostile content-addressing field that is NOT a canonical hash: the
    // originals-store confinement must refuse it before any path is handed out.
    const id = seedItem('video', {
      contentHash: '../../../../etc/passwd',
      mimeType: 'video/mp4',
      kind: 'content_addressed',
    });
    expect(() => service.resolve(id)).toThrow(ERR_ORIGINAL_PATH_ESCAPE);
  });

  it('makes NO network call while resolving a memory (AC-4)', () => {
    const spies = installEgressSpies();
    try {
      const service = createMediaFileService({ db, root });
      const id = seedItem('audio', {
        contentHash: hash('e'),
        mimeType: 'audio/mpeg',
        kind: 'content_addressed',
      });
      service.resolve(id);
      spies.assertNoEgress();
    } finally {
      spies.restore();
    }
  });

  // ── In-place SERVE-TIME confinement (§2.4 / the 🔴 fix) ───────────────────
  // Content-addressed originals live UNDER the library root (assertWithinRoot,
  // above). In-place originals are the user's OWN files in a watched folder — they
  // legitimately live OUTSIDE the library, so import-time validation alone leaves a
  // TOCTOU: a later symlink swap at the same recorded path would stream the target's
  // raw bytes into the untrusted renderer. The service must therefore realpath the
  // file at SERVE time and confine it to a registered source root.
  describe('in-place serve-time confinement', () => {
    function seedInPlace(mediaType: MediaType, srcId: string, path: string): string {
      const id = repo.insertItem({ mediaType, mimeType: 'video/mp4', originalExt: '.mp4' });
      repo.addOccurrence({
        itemId: id,
        sourceId: srcId,
        sourceRef: `ref/${id}`,
        originalKind: 'in_place',
        originalPath: path,
      });
      return id;
    }

    it('serves a legit in-place file that lives inside its registered source root', () => {
      const sourceDir = join(root, 'watched');
      mkdirSync(sourceDir, { recursive: true });
      const file = join(sourceDir, 'voice.mp4');
      writeFileSync(file, Buffer.from('a loved one'));
      const srcId = repo.registerSource({
        sourceKey: 'w1',
        type: 'folder',
        label: 'Watched',
        originPath: sourceDir,
        rootPath: sourceDir,
      });
      const id = seedInPlace('video', srcId, file);

      const descriptor = createMediaFileService({ db, root }).resolve(id);
      expect(descriptor).not.toBeNull();
      expect(existsSync(descriptor?.absPath ?? '')).toBe(true);
      expect(realpathSync(descriptor?.absPath ?? '')).toBe(realpathSync(file));
    });

    it('REJECTS an in-place path whose realpath ESCAPES the source root (symlink swap — TOCTOU)', () => {
      const sourceDir = join(root, 'watched2');
      const outsideDir = join(root, 'outside2');
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      const secret = join(outsideDir, 'secret.bin');
      writeFileSync(secret, Buffer.from('SECRET-BYTES'));
      // The recorded path sits inside the source root, but is now a symlink to a
      // file OUTSIDE it — exactly the swap import-time validation cannot catch.
      const link = join(sourceDir, 'voice.mp4');
      symlinkSync(secret, link);
      const srcId = repo.registerSource({
        sourceKey: 'w2',
        type: 'folder',
        label: 'Watched2',
        originPath: sourceDir,
        rootPath: sourceDir,
      });
      const id = seedInPlace('video', srcId, link);

      expect(() => createMediaFileService({ db, root }).resolve(id)).toThrow(
        ERR_ORIGINAL_PATH_ESCAPE,
      );
    });

    it('REJECTS an in-place path recorded OUTSIDE every registered source root', () => {
      const sourceDir = join(root, 'watched3');
      const outsideDir = join(root, 'outside3');
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      const stray = join(outsideDir, 'stray.mp4');
      writeFileSync(stray, Buffer.from('x'));
      const srcId = repo.registerSource({
        sourceKey: 'w3',
        type: 'folder',
        label: 'Watched3',
        originPath: sourceDir,
        rootPath: sourceDir,
      });
      const id = seedInPlace('video', srcId, stray);

      expect(() => createMediaFileService({ db, root }).resolve(id)).toThrow(
        ERR_ORIGINAL_PATH_ESCAPE,
      );
    });

    it('end to end: streams a legit in-place file (200) but 404s a symlink-escape with ZERO bytes', async () => {
      const sourceDir = join(root, 'watchedE');
      const outsideDir = join(root, 'outsideE');
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      const srcId = repo.registerSource({
        sourceKey: 'we',
        type: 'folder',
        label: 'WatchedE',
        originPath: sourceDir,
        rootPath: sourceDir,
      });

      const good = join(sourceDir, 'clip.mp4');
      writeFileSync(good, Buffer.from('HELLO-CLIP'));
      const goodId = seedInPlace('video', srcId, good);

      const secret = join(outsideDir, 'passwd');
      writeFileSync(secret, Buffer.from('SECRET-BYTES'));
      const evilLink = join(sourceDir, 'evil.mp4');
      symlinkSync(secret, evilLink);
      const evilId = seedInPlace('video', srcId, evilLink);

      const service = createMediaFileService({ db, root });
      const handler = createMediaProtocolHandler({ resolve: (id) => service.resolve(id) });

      const ok = await handler({ url: mediaUrl(goodId), headers: noRangeHeaders() });
      expect(ok.status).toBe(200);
      expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe('HELLO-CLIP');

      const blocked = await handler({ url: mediaUrl(evilId), headers: noRangeHeaders() });
      expect(blocked.status).toBe(404);
      expect((await blocked.arrayBuffer()).byteLength).toBe(0);
    });
  });
});

describe('isServablePath — realpath allowlist (§2.4)', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('servable');
  });
  afterEach(() => {
    removeTmpDir(root);
  });

  it('allows a real file contained within a servable root', () => {
    const dir = join(root, 'src');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'a.mp4');
    writeFileSync(file, Buffer.from('x'));
    expect(isServablePath(file, [dir])).toBe(true);
  });

  it('allows a path byte-equal to a servable root entry (single-file selection)', () => {
    const file = join(root, 'single.mp4');
    writeFileSync(file, Buffer.from('x'));
    expect(isServablePath(file, [file])).toBe(true);
  });

  it('rejects a symlink whose realpath escapes every servable root', () => {
    const dir = join(root, 'src2');
    const out = join(root, 'out2');
    mkdirSync(dir, { recursive: true });
    mkdirSync(out, { recursive: true });
    const secret = join(out, 'secret');
    writeFileSync(secret, Buffer.from('S'));
    const link = join(dir, 'link.mp4');
    symlinkSync(secret, link);
    expect(isServablePath(link, [dir])).toBe(false);
  });

  it('rejects a file outside every servable root, and a missing path', () => {
    const dir = join(root, 'src3');
    const out = join(root, 'out3');
    mkdirSync(dir, { recursive: true });
    mkdirSync(out, { recursive: true });
    const stray = join(out, 'stray');
    writeFileSync(stray, Buffer.from('S'));
    expect(isServablePath(stray, [dir])).toBe(false);
    expect(isServablePath(join(dir, 'ghost.mp4'), [dir])).toBe(false);
  });

  it('rejects when the servable-roots allowlist is empty', () => {
    const file = join(root, 'x.mp4');
    writeFileSync(file, Buffer.from('x'));
    expect(isServablePath(file, [])).toBe(false);
  });
});
