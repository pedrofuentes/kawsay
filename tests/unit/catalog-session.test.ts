import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCatalogSession } from '../../electron/main/app/catalog-session';
import { openCatalog } from '../../electron/main/db/connection';
import { createCatalogRepo } from '../../electron/main/db/catalog-repo';
import { librarySummarySchema, itemCardSchema } from '@shared/ipc/schemas';
import type { SourceType } from '@shared/catalog';
import type { IngestionCoordinator } from '../../electron/main/importers/ingestion/coordinator';
import type { IngestionJobSpec } from '../../electron/main/importers/ingestion/protocol';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const JOB_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** A coordinator double that records the jobs it is asked to start / cancel. */
function fakeCoordinator() {
  const started: IngestionJobSpec[] = [];
  const cancelled: string[] = [];
  let disposed = 0;
  const coordinator: IngestionCoordinator = {
    start: (job) => started.push(job),
    cancel: (jobId) => {
      cancelled.push(jobId);
      return true;
    },
    disposeAll: () => {
      disposed += 1;
    },
    active: () => started.map((j) => j.jobId),
  };
  return {
    coordinator,
    started,
    cancelled,
    get disposed() {
      return disposed;
    },
  };
}

/** Seed a few timeline items straight into a library's catalog (mirrors what the
 *  ingestion worker writes), via an independent connection. */
function seedItems(catalogPath: string): void {
  const db = openCatalog(catalogPath);
  const repo = createCatalogRepo(db);
  const sourceId = repo.registerSource({ sourceKey: 'seed', type: 'folder', label: 'Seed' });
  const dates = [
    '2020-01-01T00:00:00.000Z',
    '2020-02-01T00:00:00.000Z',
    '2020-03-01T00:00:00.000Z',
  ];
  dates.forEach((captureDate, i) => {
    const itemId = repo.insertItem({
      mediaType: 'photo',
      mimeType: 'image/jpeg',
      contentHash: `hash-${i}`,
      captureDate,
      width: 480,
      height: 320,
      title: `Photo ${i}`,
      searchMeta: i === 0 ? 'beach sunset' : 'mountain',
    });
    repo.addOccurrence({ itemId, sourceId, sourceRef: `ref-${i}`, originalKind: 'in_place' });
  });
  db.close();
}

/** Seed two memories from two different connector sources (whatsapp + folder),
 *  both matching "familia", so source-filter and source-projection are testable. */
function seedMultiSource(catalogPath: string): void {
  const db = openCatalog(catalogPath);
  const repo = createCatalogRepo(db);
  const whatsapp = repo.registerSource({ sourceKey: 'wa', type: 'whatsapp', label: 'WhatsApp' });
  const folder = repo.registerSource({ sourceKey: 'fold', type: 'folder', label: 'Folder' });
  const wa = repo.insertItem({
    mediaType: 'message',
    contentHash: 'h-wa',
    title: 'WhatsApp memory',
    description: 'familia en la playa',
  });
  repo.addOccurrence({ itemId: wa, sourceId: whatsapp, sourceRef: 'wa/1' });
  const fo = repo.insertItem({
    mediaType: 'photo',
    contentHash: 'h-fo',
    title: 'Folder memory',
    description: 'familia con la abuela',
  });
  repo.addOccurrence({
    itemId: fo,
    sourceId: folder,
    sourceRef: 'fold/1',
    originalKind: 'in_place',
  });
  db.close();
}

/** Seed one photo whose original is a real local file (in_place), returning its
 *  opaque id so a thumbnail call can be resolved through the session. */
function seedPhotoWithLocalOriginal(catalogPath: string, originalPath: string): string {
  const db = openCatalog(catalogPath);
  const repo = createCatalogRepo(db);
  const src = repo.registerSource({ sourceKey: 'photos', type: 'folder', label: 'Photos' });
  const id = repo.insertItem({ mediaType: 'photo', contentHash: 'h-real', originalExt: '.jpg' });
  repo.addOccurrence({
    itemId: id,
    sourceId: src,
    sourceRef: 'p/1',
    originalKind: 'in_place',
    originalPath,
  });
  db.close();
  return id;
}

/** Seed one audio item whose original is a real local file (in_place), returning
 *  its opaque id so the transcription port can resolve + enumerate it (#157). */
function seedAudioWithLocalOriginal(catalogPath: string, originalPath: string): string {
  const db = openCatalog(catalogPath);
  const repo = createCatalogRepo(db);
  const src = repo.registerSource({ sourceKey: 'voices', type: 'folder', label: 'Voices' });
  const id = repo.insertItem({ mediaType: 'audio', contentHash: 'h-voice', durationSec: 12 });
  repo.addOccurrence({
    itemId: id,
    sourceId: src,
    sourceRef: 'v/1',
    originalKind: 'in_place',
    originalPath,
  });
  db.close();
  return id;
}

describe('createCatalogSession (the IPC application service)', () => {
  let parent: string;
  let root: string;
  let coordinator: ReturnType<typeof fakeCoordinator>;
  let session: ReturnType<typeof createCatalogSession>;

  beforeEach(() => {
    parent = makeTmpDir('session');
    root = join(parent, 'Mum');
    coordinator = fakeCoordinator();
    session = createCatalogSession({ coordinator: coordinator.coordinator, newId: () => JOB_ID });
  });
  afterEach(() => {
    session.dispose();
    removeTmpDir(parent);
  });

  it('creates a library and returns a DTO WITHOUT the internal catalogPath', () => {
    const dto = session.createLibrary({ path: root, personName: 'Mum' });
    expect(librarySummarySchema.safeParse(dto).success).toBe(true);
    expect(dto).toMatchObject({ root, name: 'Mum', schemaVersion: expect.any(Number) });
    expect(dto).not.toHaveProperty('catalogPath');
  });

  it('opens an existing library', () => {
    session.createLibrary({ path: root });
    session.dispose();
    const reopened = session.openLibrary({ path: root });
    expect(reopened.root).toBe(root);
  });

  it('refuses catalog reads / imports when no library is open', () => {
    expect(() => session.getTimeline({ limit: 10 })).toThrow();
    expect(() => session.search({ query: 'x', limit: 10, offset: 0 })).toThrow();
    expect(() => session.beginImport({ sourceType: 'folder', inputPath: root })).toThrow();
  });

  it('returns timeline tiles as renderer-safe ItemCards, paged by an opaque cursor', () => {
    const dto = session.createLibrary({ path: root });
    seedItems(join(root, 'catalog.sqlite3'));

    const page1 = session.getTimeline({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    for (const item of page1.items) {
      expect(itemCardSchema.safeParse(item).success).toBe(true);
      expect(item).not.toHaveProperty('contentHash');
    }
    expect(typeof page1.nextCursor).toBe('string');

    const page2 = session.getTimeline({ limit: 2, cursor: page1.nextCursor ?? undefined });
    expect(page2.items).toHaveLength(1); // 3 seeded total
    // newest-first: page 1 holds the two most recent, page 2 the oldest
    expect(page2.items[0]?.captureDate).toBe('2020-01-01T00:00:00.000Z');
    expect(dto.root).toBe(root);
  });

  it('rejects a malformed timeline cursor', () => {
    session.createLibrary({ path: root });
    expect(() => session.getTimeline({ limit: 2, cursor: 'not-a-real-cursor!!' })).toThrow();
  });

  it('searches the catalog and maps rows to ItemCards', () => {
    session.createLibrary({ path: root });
    seedItems(join(root, 'catalog.sqlite3'));
    const result = session.search({ query: 'beach', limit: 10, offset: 0 });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.items.every((i) => itemCardSchema.safeParse(i).success)).toBe(true);
  });

  it('passes a source filter through to the catalog and projects each tile’s source (AC-7)', () => {
    session.createLibrary({ path: root });
    seedMultiSource(join(root, 'catalog.sqlite3'));

    // Unfiltered: every source comes back, each tile carrying its connector source.
    const all = session.search({ query: 'familia', limit: 10, offset: 0 });
    expect(all.total).toBe(2);
    expect(all.items.every((i) => itemCardSchema.safeParse(i).success)).toBe(true);
    expect(new Set(all.items.map((i) => i.source))).toEqual(new Set(['whatsapp', 'folder']));

    // Filtered to one connector: only that source’s memories survive.
    const onlyWhatsapp = session.search({
      query: 'familia',
      limit: 10,
      offset: 0,
      source: 'whatsapp',
    });
    expect(onlyWhatsapp.total).toBe(1);
    expect(onlyWhatsapp.items.map((i) => i.source)).toEqual(['whatsapp']);
  });

  it('beginImport registers a source and starts a well-formed off-thread job', () => {
    session.createLibrary({ path: root });
    const { jobId } = session.beginImport({ sourceType: 'folder', inputPath: root });

    expect(jobId).toBe(JOB_ID);
    expect(coordinator.started).toHaveLength(1);
    const job = coordinator.started[0];
    expect(job).toMatchObject({
      jobId: JOB_ID,
      sourceType: 'folder',
      inputPath: root,
      libraryRoot: root,
      catalogPath: join(root, 'catalog.sqlite3'),
    });
    expect(job.sourceId).toBeTruthy();
    expect(job.workDir).toBe(join(root, 'extract', job.sourceId));
  });

  it('beginImport reaches every newly wired connector (Takeout, Facebook, LinkedIn)', () => {
    session.createLibrary({ path: root });
    for (const sourceType of ['google_takeout', 'facebook', 'linkedin'] as const) {
      const { jobId } = session.beginImport({ sourceType, inputPath: root });
      expect(jobId).toBe(JOB_ID);
    }
    expect(coordinator.started).toHaveLength(3);
    expect(coordinator.started.map((job) => job.sourceType)).toEqual([
      'google_takeout',
      'facebook',
      'linkedin',
    ]);
  });

  it('beginImport rejects an unknown source type and starts nothing', () => {
    session.createLibrary({ path: root });
    expect(() =>
      session.beginImport({ sourceType: 'instagram' as unknown as SourceType, inputPath: root }),
    ).toThrow();
    expect(coordinator.started).toHaveLength(0);
  });

  it('cancelImport delegates to the coordinator', () => {
    session.createLibrary({ path: root });
    const result = session.cancelImport({ jobId: JOB_ID });
    expect(result).toEqual({ cancelled: true });
    expect(coordinator.cancelled).toEqual([JOB_ID]);
  });

  it('dispose tears down the coordinator (window-close)', () => {
    session.createLibrary({ path: root });
    session.dispose();
    expect(coordinator.disposed).toBeGreaterThanOrEqual(1);
  });

  it('marks photo/video tiles renderable (hasThumbnail) and non-visual tiles not (U4)', () => {
    session.createLibrary({ path: root });
    seedMultiSource(join(root, 'catalog.sqlite3'));

    const result = session.search({ query: 'familia', limit: 10, offset: 0 });
    const byType = new Map(result.items.map((item) => [item.mediaType, item.hasThumbnail]));
    expect(byType.get('photo')).toBe(true);
    expect(byType.get('message')).toBe(false);
  });

  it('getThumbnail resolves a memory by id through the injected thumbnailer (data URL, no path leak)', async () => {
    const image = vi.fn<
      (absPath: string, maxDimension: number) => Promise<{ data: Buffer; mimeType: 'image/jpeg' }>
    >(async () => ({ data: Buffer.from('IMG'), mimeType: 'image/jpeg' }));
    const s = createCatalogSession({
      coordinator: coordinator.coordinator,
      thumbnailers: { image, video: vi.fn(async () => null) },
    });
    try {
      s.createLibrary({ path: root });
      const userFile = join(parent, 'photo.jpg');
      writeFileSync(userFile, 'JPEG-BYTES');
      const id = seedPhotoWithLocalOriginal(join(root, 'catalog.sqlite3'), userFile);

      const url = await s.getThumbnail({ id });

      expect(url).toBe(`data:image/jpeg;base64,${Buffer.from('IMG').toString('base64')}`);
      expect(image).toHaveBeenCalledTimes(1);
      // The renderer passed only the id; the session resolved the local original.
      expect(image.mock.calls[0]?.[0]).toBe(userFile);
    } finally {
      s.dispose();
    }
  });

  it('getThumbnail refuses when no library is open', async () => {
    const s = createCatalogSession({ coordinator: coordinator.coordinator });
    await expect(s.getThumbnail({ id: JOB_ID })).rejects.toThrow();
  });

  it('exposes a transcription library port that enumerates the audio/video originals (#157)', () => {
    session.createLibrary({ path: root });
    const voice = join(parent, 'voice.m4a');
    writeFileSync(voice, 'AUDIO-BYTES');
    seedAudioWithLocalOriginal(join(root, 'catalog.sqlite3'), voice);

    const items = session.transcription().listItems();

    expect(items).toHaveLength(1);
    expect(items[0]?.sourcePath).toBe(voice);
  });

  it('refuses to hand out a transcription port when no library is open (#157)', () => {
    const s = createCatalogSession({ coordinator: coordinator.coordinator });
    expect(() => s.transcription()).toThrow();
  });
});
