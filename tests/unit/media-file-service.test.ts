// Unit tests for the id→confined-path media resolver behind the `kawsay-media:`
// protocol (#428). Mirrors the thumbnail-service posture (U4 / AC-14): the
// renderer names ONLY an opaque catalog id, and the service resolves it
// server-side to a path CONFINED to the library originals via `resolveOriginal`,
// which THROWS on an escaping content-address rather than reading outside the
// store. No renderer-supplied path is ever accepted, and the whole path is
// egress-free (AC-4).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { openCatalog, type CatalogDatabase } from '../../electron/main/db/connection';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';
import { blobAbsPath, ERR_ORIGINAL_PATH_ESCAPE } from '../../electron/main/library/originals-store';
import { createMediaFileService } from '../../electron/main/library/media-file-service';
import type { MediaType } from '@shared/catalog';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';
import { installEgressSpies } from '../ac4/egress-spies';

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
});
