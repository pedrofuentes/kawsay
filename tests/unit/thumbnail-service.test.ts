import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { openCatalog, type CatalogDatabase } from '../../electron/main/db/connection';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';
import { blobAbsPath, ERR_ORIGINAL_PATH_ESCAPE } from '../../electron/main/library/originals-store';
import {
  createThumbnailService,
  type ThumbnailImage,
} from '../../electron/main/library/thumbnail-service';
import type { MediaType } from '@shared/catalog';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';
import { installEgressSpies } from '../ac4/egress-spies';

/** A canonical 64-hex content hash seeded from a single distinguishing nibble. */
function hash(nibble: string): string {
  return nibble.repeat(64);
}

/** A spied image thumbnailer returning fixed bytes (the service never decodes). */
function fakeImage(image: ThumbnailImage | null = { data: Buffer.from([1, 2, 3, 4]), mimeType: 'image/jpeg' }) {
  return vi.fn<(absPath: string, maxDimension: number) => Promise<ThumbnailImage | null>>(
    async () => image,
  );
}
function fakeVideo(image: ThumbnailImage | null = { data: Buffer.from('WEBP'), mimeType: 'image/webp' }) {
  return vi.fn<(absPath: string, maxDimension: number) => Promise<ThumbnailImage | null>>(
    async () => image,
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createThumbnailService (on-demand, id-keyed, path-confined — U4 / AC-14)', () => {
  let root: string;
  let db: CatalogDatabase;
  let repo: CatalogRepo;
  let sourceId: string;

  beforeEach(() => {
    root = makeTmpDir('thumb-svc');
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
    opts: { contentHash?: string | null; kind?: 'content_addressed' | 'in_place' | 'none'; path?: string } = {},
  ): string {
    const id = repo.insertItem({
      mediaType,
      contentHash: opts.contentHash ?? null,
      originalExt: '.jpg',
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

  it('resolves a photo by id and renders it to a bounded image data URL', async () => {
    const image = fakeImage();
    const video = fakeVideo(null);
    const service = createThumbnailService({ db, root, image, video });
    const id = seedItem('photo', { contentHash: hash('a'), kind: 'content_addressed' });

    const url = await service.getThumbnail(id);

    expect(url).toBe(`data:image/jpeg;base64,${Buffer.from([1, 2, 3, 4]).toString('base64')}`);
    expect(image).toHaveBeenCalledTimes(1);
    // The renderer passed only the id; the service handed the thumbnailer the
    // confined blob path it resolved server-side (never a renderer-supplied path).
    expect(image.mock.calls[0]?.[0]).toBe(blobAbsPath(root, hash('a'), '.jpg'));
    expect(image.mock.calls[0]?.[1]).toBeLessThanOrEqual(320);
    expect(video).not.toHaveBeenCalled();
  });

  it('renders a video by extracting a frame through the video thumbnailer', async () => {
    const image = fakeImage();
    const video = fakeVideo();
    const service = createThumbnailService({ db, root, image, video });
    const id = seedItem('video', { contentHash: hash('b'), kind: 'content_addressed' });

    const url = await service.getThumbnail(id);

    expect(url).toBe(`data:image/webp;base64,${Buffer.from('WEBP').toString('base64')}`);
    expect(video).toHaveBeenCalledTimes(1);
    expect(image).not.toHaveBeenCalled();
  });

  it('caches a rendition — a second call returns the same URL without regenerating', async () => {
    const image = fakeImage({ data: Buffer.from('X'), mimeType: 'image/jpeg' });
    const service = createThumbnailService({ db, root, image, video: fakeVideo(null) });
    const id = seedItem('photo', { contentHash: hash('c'), kind: 'content_addressed' });

    const first = await service.getThumbnail(id);
    const second = await service.getThumbnail(id);

    expect(first).toBe(second);
    expect(image).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent renders for the same id and size in main before caching', async () => {
    const pending = deferred<ThumbnailImage | null>();
    const image = vi.fn<(absPath: string, maxDimension: number) => Promise<ThumbnailImage | null>>(
      () => pending.promise,
    );
    const service = createThumbnailService({ db, root, image, video: fakeVideo(null) });
    const id = seedItem('photo', { contentHash: hash('9'), kind: 'content_addressed' });

    const first = service.getThumbnail(id);
    const second = service.getThumbnail(id);

    expect(image).toHaveBeenCalledTimes(1);
    pending.resolve({ data: Buffer.from('DEDUP'), mimeType: 'image/jpeg' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      `data:image/jpeg;base64,${Buffer.from('DEDUP').toString('base64')}`,
      `data:image/jpeg;base64,${Buffer.from('DEDUP').toString('base64')}`,
    ]);
    expect(image).toHaveBeenCalledTimes(1);
  });

  it('returns null for non-visual media WITHOUT resolving or reading any original', async () => {
    const image = fakeImage();
    const video = fakeVideo();
    const service = createThumbnailService({ db, root, image, video });
    for (const mediaType of ['audio', 'document', 'message'] as const) {
      const id = seedItem(mediaType, { contentHash: null, kind: 'none' });
      expect(await service.getThumbnail(id)).toBeNull();
    }
    expect(image).not.toHaveBeenCalled();
    expect(video).not.toHaveBeenCalled();
  });

  it('returns null when the original cannot be decoded (thumbnailer yields null)', async () => {
    const service = createThumbnailService({ db, root, image: fakeImage(null), video: fakeVideo(null) });
    const id = seedItem('photo', { contentHash: hash('d'), kind: 'content_addressed' });
    expect(await service.getThumbnail(id)).toBeNull();
  });

  it('returns null for an unknown id (no row) without throwing', async () => {
    const service = createThumbnailService({ db, root, image: fakeImage(), video: fakeVideo() });
    expect(await service.getThumbnail('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('REJECTS a stored content hash that would escape the library root (confinement)', async () => {
    const image = fakeImage();
    const service = createThumbnailService({ db, root, image, video: fakeVideo() });
    // A hostile, content-addressing field that is NOT a canonical hash — the
    // originals-store confinement must refuse it before any path is built.
    const id = seedItem('photo', { contentHash: '../../../../etc/passwd', kind: 'content_addressed' });

    await expect(service.getThumbnail(id)).rejects.toThrow(ERR_ORIGINAL_PATH_ESCAPE);
    expect(image).not.toHaveBeenCalled(); // no read is ever attempted outside the store
  });

  it('drops an oversized rendition (byte cap) → null', async () => {
    const service = createThumbnailService({
      db,
      root,
      image: fakeImage({ data: Buffer.alloc(10), mimeType: 'image/jpeg' }),
      video: fakeVideo(null),
      maxBytes: 4,
    });
    const id = seedItem('photo', { contentHash: hash('e'), kind: 'content_addressed' });
    expect(await service.getThumbnail(id)).toBeNull();
  });

  it('clamps the requested size into the allowed bound before generating', async () => {
    const image = fakeImage({ data: Buffer.from('X'), mimeType: 'image/jpeg' });
    const service = createThumbnailService({ db, root, image, video: fakeVideo(null) });
    const tooBig = seedItem('photo', { contentHash: hash('1'), kind: 'content_addressed' });
    const tooSmall = seedItem('photo', { contentHash: hash('2'), kind: 'content_addressed' });

    await service.getThumbnail(tooBig, 99_999);
    await service.getThumbnail(tooSmall, 1);

    expect(image.mock.calls[0]?.[1]).toBe(320); // clamped to max
    expect(image.mock.calls[1]?.[1]).toBe(16); // clamped to min
  });

  it('makes NO network call while resolving and generating a thumbnail (AC-4)', async () => {
    const spies = installEgressSpies();
    try {
      const service = createThumbnailService({
        db,
        root,
        image: fakeImage({ data: Buffer.from('IMG'), mimeType: 'image/jpeg' }),
        video: fakeVideo(null),
      });
      const id = seedItem('photo', { contentHash: hash('f'), kind: 'content_addressed' });
      await service.getThumbnail(id);
      spies.assertNoEgress();
    } finally {
      spies.restore();
    }
  });
});
