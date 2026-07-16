import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCatalogSession } from '../../electron/main/app/catalog-session';
import { openCatalog } from '../../electron/main/db/connection';
import { createCatalogRepo } from '../../electron/main/db/catalog-repo';
import { createTranscriptRepo } from '../../electron/main/db/transcript-repo';
import { createEmbeddingsRepo } from '../../electron/main/db/embeddings-repo';
import { EMBED_MODEL_ID } from '../../electron/main/search/embed-cli';
import { librarySummarySchema, itemCardSchema, transcriptViewSchema } from '@shared/ipc/schemas';
import type { SourceType } from '@shared/catalog';
import type { IngestionCoordinator } from '../../electron/main/importers/ingestion/coordinator';
import type { IngestionJobSpec } from '../../electron/main/importers/ingestion/protocol';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const JOB_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

// The catalog session resolves the per-arch ffmpeg + ffprobe paths for an import
// job lazily (#175); the worker spawn is faked in these tests, so placeholder
// paths suffice — they only need to flow through into the IngestionJobSpec.
const resolveMediaBinaries = () => ({ ffmpegPath: '/bin/ffmpeg', ffprobePath: '/bin/ffprobe' });

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

/**
 * Seed one exact-lexical match ("beach") plus one semantically-related memory that
 * shares NO lexical overlap ("la playa") but carries a stored embedding aligned
 * with the query vector the mock embedder returns. Exercises the ADR-0029 merge:
 * the exact item is preserved & ranked ahead, the semantic-only item is appended.
 */
function seedSemanticCorpus(catalogPath: string): { exactId: string; semanticId: string } {
  const db = openCatalog(catalogPath);
  const repo = createCatalogRepo(db);
  const embeddings = createEmbeddingsRepo(db);
  const src = repo.registerSource({ sourceKey: 'seed', type: 'folder', label: 'Seed' });
  const exactId = repo.insertItem({
    mediaType: 'message',
    contentHash: 'h-exact',
    description: 'beach sunset',
  });
  repo.addOccurrence({ itemId: exactId, sourceId: src, sourceRef: 'e/1' });
  const semanticId = repo.insertItem({
    mediaType: 'photo',
    contentHash: 'h-semantic',
    description: 'la playa',
  });
  repo.addOccurrence({ itemId: semanticId, sourceId: src, sourceRef: 's/1' });
  // Only the semantic-only memory carries a vector aligned with the query (below).
  embeddings.upsertEmbedding(semanticId, EMBED_MODEL_ID, Float32Array.from([1, 0, 0]));
  db.close();
  return { exactId, semanticId };
}

/**
 * Seed a corpus that straddles the exact→semantic boundary for pagination tests:
 * THREE exact-lexical matches for "familia" (no embeddings) plus TWO
 * semantically-related memories with NO lexical overlap ("la playa") whose stored
 * vectors align with the query vector. The globally-merged order is therefore
 * [3 exact ranked first, AC-29] ++ [2 semantic-only by score], so paging with
 * limit 2 crosses the boundary mid-page (page 1 = last exact + first semantic-only).
 */
function seedPaginationCorpus(catalogPath: string): {
  exactIds: string[];
  semanticIds: string[];
} {
  const db = openCatalog(catalogPath);
  const repo = createCatalogRepo(db);
  const embeddings = createEmbeddingsRepo(db);
  const src = repo.registerSource({ sourceKey: 'seed', type: 'folder', label: 'Seed' });
  const exactIds = ['uno', 'dos', 'tres'].map((word, i) => {
    const id = repo.insertItem({
      mediaType: 'message',
      contentHash: `h-e${i}`,
      description: `familia ${word}`,
    });
    repo.addOccurrence({ itemId: id, sourceId: src, sourceRef: `e/${i}` });
    return id;
  });
  // Distinct cosine scores (1.0, then ~0.99 vs the [1,0,0] query) so the KNN order
  // is deterministic; neither carries the lexical token "familia".
  const vectors = [Float32Array.from([1, 0, 0]), Float32Array.from([0.9, 0.1, 0])];
  const semanticIds = vectors.map((vector, i) => {
    const id = repo.insertItem({
      mediaType: 'photo',
      contentHash: `h-s${i}`,
      description: `la playa ${i}`,
    });
    repo.addOccurrence({ itemId: id, sourceId: src, sourceRef: `s/${i}` });
    embeddings.upsertEmbedding(id, EMBED_MODEL_ID, vector);
    return id;
  });
  db.close();
  return { exactIds, semanticIds };
}

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

/** Seed an audio item and attach a finished transcript to it (mirrors what the
 *  #134 worker persists via transcript-repo), returning its opaque id. */
function seedTranscribedAudio(
  catalogPath: string,
  over: { language?: string | null; text?: string } = {},
): string {
  const db = openCatalog(catalogPath);
  const repo = createCatalogRepo(db);
  const transcripts = createTranscriptRepo(db);
  const id = repo.insertItem({ mediaType: 'audio', contentHash: 'h-done', durationSec: 12 });
  transcripts.saveTranscript({
    itemId: id,
    text: over.text ?? 'Hola, te quiero mucho.',
    language: over.language === undefined ? 'es' : over.language,
    segments: [{ startMs: 0, endMs: 1500, text: over.text ?? 'Hola, te quiero mucho.' }],
  });
  db.close();
  return id;
}

/** Seed an audio item and leave it un-transcribed but with a chosen drain status. */
function seedAudioWithStatus(
  catalogPath: string,
  status: 'pending' | 'failed' | 'skipped',
): string {
  const db = openCatalog(catalogPath);
  const repo = createCatalogRepo(db);
  const transcripts = createTranscriptRepo(db);
  const id = repo.insertItem({ mediaType: 'audio', contentHash: `h-${status}`, durationSec: 7 });
  if (status !== 'pending') transcripts.setStatus(id, status);
  db.close();
  return id;
}

/** Seed an audio item whose status says `done` but whose transcript ROW is absent
 *  (a torn/corrupt write the read path must survive calmly, #164). */
function seedDoneButRowless(catalogPath: string): string {
  const db = openCatalog(catalogPath);
  const repo = createCatalogRepo(db);
  const transcripts = createTranscriptRepo(db);
  const id = repo.insertItem({ mediaType: 'audio', contentHash: 'h-rowless', durationSec: 9 });
  transcripts.setStatus(id, 'done');
  db.close();
  return id;
}

/** Seed a `done` transcript, then corrupt its stored segments JSON so a load throws (#164). */
function seedDoneWithBadSegments(catalogPath: string): string {
  const db = openCatalog(catalogPath);
  const repo = createCatalogRepo(db);
  const transcripts = createTranscriptRepo(db);
  const id = repo.insertItem({ mediaType: 'audio', contentHash: 'h-badseg', durationSec: 9 });
  transcripts.saveTranscript({
    itemId: id,
    text: 'Hola.',
    language: 'es',
    segments: [{ startMs: 0, endMs: 1000, text: 'Hola.' }],
  });
  db.prepare('UPDATE transcripts SET segments = ? WHERE item_id = ?').run('{ not valid json', id);
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
    session = createCatalogSession({
      coordinator: coordinator.coordinator,
      newId: () => JOB_ID,
      resolveMediaBinaries,
    });
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

  it('refuses catalog reads / imports when no library is open', async () => {
    expect(() => session.getTimeline({ limit: 10 })).toThrow();
    await expect(session.search({ query: 'x', limit: 10, offset: 0 })).rejects.toThrow();
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

  it('bounds untrusted ItemCard title and description strings', async () => {
    session.createLibrary({ path: root });
    const db = openCatalog(join(root, 'catalog.sqlite3'));
    const repo = createCatalogRepo(db);
    const sourceId = repo.registerSource({
      sourceKey: 'seed-long',
      type: 'facebook',
      label: 'Seed',
    });
    repo.addOccurrence({
      itemId: repo.insertItem({
        mediaType: 'message',
        contentHash: 'long-text',
        title: 'T'.repeat(20_000),
        description: 'D'.repeat(200_000),
        searchMeta: 'needle',
      }),
      sourceId,
      sourceRef: 'long/1',
    });
    db.close();

    const [item] = (await session.search({ query: 'needle', limit: 10, offset: 0 })).items;

    expect(itemCardSchema.safeParse(item).success).toBe(true);
    expect(item?.title).toHaveLength(200);
    expect(item?.description).toHaveLength(4096);
  });

  it('rejects a malformed timeline cursor', () => {
    session.createLibrary({ path: root });
    expect(() => session.getTimeline({ limit: 2, cursor: 'not-a-real-cursor!!' })).toThrow();
  });

  it('searches the catalog and maps rows to ItemCards', async () => {
    session.createLibrary({ path: root });
    seedItems(join(root, 'catalog.sqlite3'));
    const result = await session.search({ query: 'beach', limit: 10, offset: 0 });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.items.every((i) => itemCardSchema.safeParse(i).success)).toBe(true);
  });

  it('passes a source filter through to the catalog and projects each tile’s source (AC-7)', async () => {
    session.createLibrary({ path: root });
    seedMultiSource(join(root, 'catalog.sqlite3'));

    // Unfiltered: every source comes back, each tile carrying its connector source.
    const all = await session.search({ query: 'familia', limit: 10, offset: 0 });
    expect(all.total).toBe(2);
    expect(all.items.every((i) => itemCardSchema.safeParse(i).success)).toBe(true);
    expect(new Set(all.items.map((i) => i.source))).toEqual(new Set(['whatsapp', 'folder']));

    // Filtered to one connector: only that source’s memories survive.
    const onlyWhatsapp = await session.search({
      query: 'familia',
      limit: 10,
      offset: 0,
      source: 'whatsapp',
    });
    expect(onlyWhatsapp.total).toBe(1);
    expect(onlyWhatsapp.items.map((i) => i.source)).toEqual(['whatsapp']);
  });

  it('undoImport removes THIS import\'s source but spares an item deduped into another (#429)', () => {
    session.createLibrary({ path: root });
    // Seed a pre-import source A and this import's source B, sharing ONE deduped item
    // plus a B-only item, through a second connection (the session reads the commit).
    const db = openCatalog(join(root, 'catalog.sqlite3'));
    const repo = createCatalogRepo(db);
    const sourceA = repo.registerSource({ sourceKey: 'A', type: 'google_takeout', label: 'A' });
    const sourceB = repo.registerSource({ sourceKey: 'B', type: 'whatsapp', label: 'B' });
    const shared = repo.insertItem({ mediaType: 'photo', contentHash: 'shared', originalExt: '.jpg' });
    repo.addOccurrence({ itemId: shared, sourceId: sourceA, sourceRef: 'A/1', originalKind: 'none' });
    repo.addOccurrence({ itemId: shared, sourceId: sourceB, sourceRef: 'B/1', originalKind: 'none' });
    const onlyB = repo.insertItem({ mediaType: 'photo', contentHash: 'onlyB', originalExt: '.jpg' });
    repo.addOccurrence({ itemId: onlyB, sourceId: sourceB, sourceRef: 'B/2', originalKind: 'none' });
    db.close();

    const result = session.undoImport({ sourceId: sourceB });

    // Only B's contribution goes: the deduped item survives (its A occurrence remains);
    // the B-only item is dropped. Two occurrences removed, one item removed.
    expect(result).toEqual({ itemsRemoved: 1, occurrencesRemoved: 2 });
    const after = openCatalog(join(root, 'catalog.sqlite3'));
    expect(Number((after.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n)).toBe(1);
    expect(
      Number((after.prepare('SELECT COUNT(*) AS n FROM item_occurrences').get() as { n: number }).n),
    ).toBe(1);
    after.close();
  });

  it('undoImport throws when no library is open', () => {
    expect(() => session.undoImport({ sourceId: JOB_ID })).toThrow();
  });

  it('undoImport refuses while an import is still in flight (race guard, #429)', () => {
    session.createLibrary({ path: root });
    // Start an import so the coordinator reports an active job; undo must refuse rather
    // than remove rows out from under a still-writing worker.
    session.beginImport({ sourceType: 'folder', inputPath: root });
    expect(coordinator.started.length).toBeGreaterThan(0);
    expect(() => session.undoImport({ sourceId: JOB_ID })).toThrow(/in progress/i);
  });

  it('beginImport registers a source and starts a well-formed off-thread job', () => {
    session.createLibrary({ path: root });
    const { jobId, sourceId } = session.beginImport({ sourceType: 'folder', inputPath: root });

    expect(jobId).toBe(JOB_ID);
    expect(sourceId).toBeTruthy(); // echoed so the renderer can later undo this import (#429)
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

  it('beginImport resolves media binaries before registering a source (no orphan row on throw)', () => {
    const s = createCatalogSession({
      coordinator: coordinator.coordinator,
      newId: () => JOB_ID,
      resolveMediaBinaries: () => {
        throw new Error('ffmpeg missing');
      },
    });
    try {
      s.createLibrary({ path: root });

      expect(() => s.beginImport({ sourceType: 'folder', inputPath: root })).toThrow(
        'ffmpeg missing',
      );

      expect(coordinator.started).toHaveLength(0);
      const db = openCatalog(join(root, 'catalog.sqlite3'));
      try {
        const row = db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number };
        expect(row.n).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      s.dispose();
    }
  });

  it('beginImport reaches every newly wired connector (Takeout, Facebook, LinkedIn, iMessage/SMS)', () => {
    // One import runs at a time (the concurrent-job guard, #427), so each connector
    // is exercised on its own fresh session rather than back-to-back on one.
    const sourceTypes = ['google_takeout', 'facebook', 'linkedin', 'imessage'] as const;
    for (const sourceType of sourceTypes) {
      const localCoordinator = fakeCoordinator();
      const s = createCatalogSession({
        coordinator: localCoordinator.coordinator,
        newId: () => JOB_ID,
        resolveMediaBinaries,
      });
      try {
        s.createLibrary({ path: join(parent, sourceType) });
        const { jobId } = s.beginImport({ sourceType, inputPath: root });
        expect(jobId).toBe(JOB_ID);
        expect(localCoordinator.started).toHaveLength(1);
        expect(localCoordinator.started[0].sourceType).toBe(sourceType);
      } finally {
        s.dispose();
      }
    }
  });

  it('beginImport refuses a concurrent import while one is already running, starting nothing new (#427)', () => {
    session.createLibrary({ path: root });
    session.beginImport({ sourceType: 'folder', inputPath: root });
    expect(coordinator.started).toHaveLength(1);

    // A second start while the first job is still active (e.g. the user left the
    // Add Memories view mid-import and returned) must be refused, not orphan-stacked.
    expect(() => session.beginImport({ sourceType: 'folder', inputPath: root })).toThrow(
      /already in progress/i,
    );
    expect(coordinator.started).toHaveLength(1);
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

  it('marks photo/video tiles renderable (hasThumbnail) and non-visual tiles not (U4)', async () => {
    session.createLibrary({ path: root });
    seedMultiSource(join(root, 'catalog.sqlite3'));

    const result = await session.search({ query: 'familia', limit: 10, offset: 0 });
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
      resolveMediaBinaries,
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
    const s = createCatalogSession({ coordinator: coordinator.coordinator, resolveMediaBinaries });
    await expect(s.getThumbnail({ id: JOB_ID })).rejects.toThrow();
  });

  describe('setFavourite (#434 favourite-toggle write path)', () => {
    it('marks a memory favourite and echoes the resolved state', () => {
      session.createLibrary({ path: root });
      seedItems(join(root, 'catalog.sqlite3'));
      const page = session.getTimeline({ limit: 1 });
      const id = page.items[0]?.id as string;
      expect(page.items[0]?.isFavourite).toBe(false);

      const result = session.setFavourite({ id, favourite: true });

      expect(result).toEqual({ isFavourite: true });
      // Persisted — a fresh timeline read reflects it, not just the echoed response.
      const reread = session.getTimeline({ limit: 1 });
      expect(reread.items[0]?.isFavourite).toBe(true);
    });

    it('unmarks a favourite memory back to false', () => {
      session.createLibrary({ path: root });
      seedItems(join(root, 'catalog.sqlite3'));
      const id = session.getTimeline({ limit: 1 }).items[0]?.id as string;
      session.setFavourite({ id, favourite: true });

      const result = session.setFavourite({ id, favourite: false });

      expect(result).toEqual({ isFavourite: false });
    });

    it('is idempotent — setting the same value twice is a no-op the second time', () => {
      session.createLibrary({ path: root });
      seedItems(join(root, 'catalog.sqlite3'));
      const id = session.getTimeline({ limit: 1 }).items[0]?.id as string;

      session.setFavourite({ id, favourite: true });
      const second = session.setFavourite({ id, favourite: true });

      expect(second).toEqual({ isFavourite: true });
    });

    it('rejects an unknown item id', () => {
      session.createLibrary({ path: root });
      expect(() => session.setFavourite({ id: JOB_ID, favourite: true })).toThrow();
    });

    it('refuses when no library is open', () => {
      const s = createCatalogSession({ coordinator: coordinator.coordinator, resolveMediaBinaries });
      expect(() => s.setFavourite({ id: JOB_ID, favourite: true })).toThrow();
    });
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
    const s = createCatalogSession({ coordinator: coordinator.coordinator, resolveMediaBinaries });
    expect(() => s.transcription()).toThrow();
  });

  it('exposes a categorization library port built from the injected factory (#270)', () => {
    const seen: { embedderAvailable: boolean }[] = [];
    const port = {
      listForItem: vi.fn(() => []),
      applyCorrection: vi.fn(() => []),
      start: vi.fn(() =>
        Promise.resolve({
          outcome: 'idle' as const,
          reason: null,
          counts: { categorized: 0, skipped: 0, failed: 0, inFlight: 0 },
        }),
      ),
      cancel: vi.fn(() => ({ cancelled: false })),
      status: vi.fn(() => ({
        state: 'idle' as const,
        counts: { categorized: 0, skipped: 0, failed: 0, inFlight: 0 },
        lastItem: null,
      })),
    };
    const s = createCatalogSession({
      coordinator: coordinator.coordinator,
      resolveMediaBinaries,
      // The embedder is AVAILABLE, so the factory must observe a themes-capable gate.
      resolveEmbedder: () => ({ available: true, embed: async () => [] }),
      categorization: (ctx) => {
        seen.push({ embedderAvailable: ctx.embedderAvailable() });
        return port;
      },
    });
    try {
      s.createLibrary({ path: root });
      // The port is built once per open library, threaded the live DB + embedder gate.
      expect(s.categorization()).toBe(port);
      expect(seen).toEqual([{ embedderAvailable: true }]);
    } finally {
      s.dispose();
    }
  });

  it('refuses to hand out a categorization port when no library is open (#270)', () => {
    const s = createCatalogSession({
      coordinator: coordinator.coordinator,
      resolveMediaBinaries,
      categorization: () => {
        throw new Error('factory must not run without an open library');
      },
    });
    expect(() => s.categorization()).toThrow();
  });

  it('refuses to hand out a categorization port when no factory is injected (#270)', () => {
    const s = createCatalogSession({ coordinator: coordinator.coordinator, resolveMediaBinaries });
    s.createLibrary({ path: root });
    try {
      expect(() => s.categorization()).toThrow();
    } finally {
      s.dispose();
    }
  });

  it('getTranscript returns a finished transcript: status done + words + detected language (#136)', async () => {
    session.createLibrary({ path: root });
    const id = seedTranscribedAudio(join(root, 'catalog.sqlite3'), {
      language: 'es',
      text: 'Hola mundo.',
    });

    const view = await session.getTranscript({ id });

    expect(transcriptViewSchema.safeParse(view).success).toBe(true);
    expect(view.status).toBe('done');
    expect(view.language).toBe('es');
    expect(view.text).toBe('Hola mundo.');
    expect(view.segments.length).toBeGreaterThan(0);
  });

  it('getTranscript returns a calm pending view (no words) for an un-transcribed item (#136)', async () => {
    session.createLibrary({ path: root });
    const id = seedAudioWithStatus(join(root, 'catalog.sqlite3'), 'pending');

    const view = await session.getTranscript({ id });

    expect(view).toEqual({ status: 'pending', language: null, text: null, segments: [] });
  });

  it('getTranscript reflects a failed / skipped drain status without any words (#136)', async () => {
    session.createLibrary({ path: root });
    const failedId = seedAudioWithStatus(join(root, 'catalog.sqlite3'), 'failed');
    const skippedId = seedAudioWithStatus(join(root, 'catalog.sqlite3'), 'skipped');

    expect(await session.getTranscript({ id: failedId })).toEqual({
      status: 'failed',
      language: null,
      text: null,
      segments: [],
    });
    expect(await session.getTranscript({ id: skippedId })).toEqual({
      status: 'skipped',
      language: null,
      text: null,
      segments: [],
    });
  });

  it('getTranscript returns a calm non-done view when a done item has no transcript row (#164)', async () => {
    session.createLibrary({ path: root });
    const id = seedDoneButRowless(join(root, 'catalog.sqlite3'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const view = await session.getTranscript({ id });

    expect(transcriptViewSchema.safeParse(view).success).toBe(true);
    expect(view.status).not.toBe('done');
    expect(view.text).toBeNull();
    expect(view.segments).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('getTranscript returns a calm non-done view when stored segments JSON is malformed (#164)', async () => {
    session.createLibrary({ path: root });
    const id = seedDoneWithBadSegments(join(root, 'catalog.sqlite3'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const view = await session.getTranscript({ id });

    expect(transcriptViewSchema.safeParse(view).success).toBe(true);
    expect(view.status).not.toBe('done');
    expect(view.text).toBeNull();
    expect(view.segments).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('getTranscript rejects an unknown item id (a transcript read never invents an item)', async () => {
    session.createLibrary({ path: root });
    await expect(session.getTranscript({ id: JOB_ID })).rejects.toThrow();
  });

  it('getTranscript refuses when no library is open (#136)', async () => {
    const s = createCatalogSession({ coordinator: coordinator.coordinator, resolveMediaBinaries });
    await expect(s.getTranscript({ id: JOB_ID })).rejects.toThrow();
  });

  describe('search — M4 smart search (ADR-0029 / AC-29)', () => {
    /** A session whose on-device embedder is AVAILABLE and returns `queryVector`
     *  for every batch; `onEmbed` observes the (prefixed) query texts. */
    function sessionWithEmbedder(
      queryVector: number[],
      onEmbed?: (texts: readonly string[]) => void,
    ): ReturnType<typeof createCatalogSession> {
      return createCatalogSession({
        coordinator: coordinator.coordinator,
        resolveMediaBinaries,
        resolveEmbedder: () => ({
          available: true,
          embed: async (texts) => {
            onEmbed?.(texts);
            return [Float32Array.from(queryVector)];
          },
        }),
      });
    }

    it('extends exact FTS with a semantically-related memory, exact ranked first (AC-29)', async () => {
      const embedded: string[][] = [];
      const s = sessionWithEmbedder([1, 0, 0], (texts) => embedded.push([...texts]));
      try {
        s.createLibrary({ path: root });
        const { exactId, semanticId } = seedSemanticCorpus(join(root, 'catalog.sqlite3'));

        const result = await s.search({ query: 'beach', limit: 10, offset: 0 });

        const ids = result.items.map((i) => i.id);
        // The lexical match AND the no-lexical-overlap semantic match are BOTH returned.
        expect(ids).toContain(exactId);
        expect(ids).toContain(semanticId);
        // AC-29: every exact result is preserved and ranked AHEAD of any semantic-only one.
        expect(ids[0]).toBe(exactId);
        expect(ids.indexOf(exactId)).toBeLessThan(ids.indexOf(semanticId));
        // The query was embedded with the e5 "query: " prefix.
        expect(embedded[0]).toEqual(['query: beach']);
        // total EXTENDS the exact-FTS count by the appended semantic-only memory.
        expect(result.total).toBe(2);
        expect(result.items.every((i) => itemCardSchema.safeParse(i).success)).toBe(true);
      } finally {
        s.dispose();
      }
    });

    it('a memory that is BOTH an exact and a semantic match appears exactly once', async () => {
      const s = sessionWithEmbedder([1, 0, 0]);
      try {
        s.createLibrary({ path: root });
        const catalogPath = join(root, 'catalog.sqlite3');
        const db = openCatalog(catalogPath);
        const repo = createCatalogRepo(db);
        const embeddings = createEmbeddingsRepo(db);
        const src = repo.registerSource({ sourceKey: 'seed', type: 'folder', label: 'Seed' });
        const bothId = repo.insertItem({
          mediaType: 'message',
          contentHash: 'h-both',
          description: 'beach playa',
        });
        repo.addOccurrence({ itemId: bothId, sourceId: src, sourceRef: 'b/1' });
        embeddings.upsertEmbedding(bothId, EMBED_MODEL_ID, Float32Array.from([1, 0, 0]));
        db.close();

        const result = await s.search({ query: 'beach', limit: 10, offset: 0 });

        expect(result.items.map((i) => i.id)).toEqual([bothId]);
        expect(result.total).toBe(1);
      } finally {
        s.dispose();
      }
    });

    it('applies the source filter to semantic hits (never surfaces an out-of-source memory)', async () => {
      const s = sessionWithEmbedder([1, 0, 0]);
      try {
        s.createLibrary({ path: root });
        const catalogPath = join(root, 'catalog.sqlite3');
        const db = openCatalog(catalogPath);
        const repo = createCatalogRepo(db);
        const embeddings = createEmbeddingsRepo(db);
        const whatsapp = repo.registerSource({ sourceKey: 'wa', type: 'whatsapp', label: 'WhatsApp' });
        const folder = repo.registerSource({ sourceKey: 'fold', type: 'folder', label: 'Folder' });
        const exactId = repo.insertItem({
          mediaType: 'message',
          contentHash: 'h-e',
          description: 'beach day',
        });
        repo.addOccurrence({ itemId: exactId, sourceId: whatsapp, sourceRef: 'wa/1' });
        const semanticId = repo.insertItem({
          mediaType: 'photo',
          contentHash: 'h-s',
          description: 'la playa',
        });
        repo.addOccurrence({ itemId: semanticId, sourceId: folder, sourceRef: 'fold/1' });
        embeddings.upsertEmbedding(semanticId, EMBED_MODEL_ID, Float32Array.from([1, 0, 0]));
        db.close();

        const result = await s.search({ query: 'beach', limit: 10, offset: 0, source: 'whatsapp' });

        // The semantic hit is a folder memory → excluded by the whatsapp filter.
        expect(result.items.map((i) => i.id)).toEqual([exactId]);
        expect(result.items.map((i) => i.id)).not.toContain(semanticId);
      } finally {
        s.dispose();
      }
    });

    it('falls back to byte-identical exact FTS when the embedder is UNAVAILABLE (no regression)', async () => {
      // The default session (beforeEach) injects no embedder → UNAVAILABLE.
      session.createLibrary({ path: root });
      const catalogPath = join(root, 'catalog.sqlite3');
      const { exactId, semanticId } = seedSemanticCorpus(catalogPath);

      const result = await session.search({ query: 'beach', limit: 10, offset: 0 });

      // The semantically-related memory (no lexical overlap) is NOT surfaced.
      expect(result.items.map((i) => i.id)).toEqual([exactId]);
      expect(result.items.map((i) => i.id)).not.toContain(semanticId);

      // Byte-identical to the unchanged FTS path (repo.search) — same ids, order, total.
      const db = openCatalog(catalogPath);
      const expected = createCatalogRepo(db).search({ query: 'beach', limit: 10, offset: 0 });
      db.close();
      expect(result.total).toBe(expected.total);
      expect(result.items.map((i) => i.id)).toEqual(expected.rows.map((r) => r.id));

      // An EXPLICITLY-unavailable embedder yields the identical exact-FTS result.
      const explicit = createCatalogSession({
        coordinator: coordinator.coordinator,
        resolveMediaBinaries,
        resolveEmbedder: () => ({ available: false, reason: 'binary-unavailable' }),
      });
      try {
        explicit.openLibrary({ path: root });
        const explicitResult = await explicit.search({ query: 'beach', limit: 10, offset: 0 });
        expect(explicitResult.items.map((i) => i.id)).toEqual([exactId]);
        expect(explicitResult.total).toBe(expected.total);
      } finally {
        explicit.dispose();
      }
    });

    it('with an available embedder but no stored embeddings yet, returns exactly exact FTS (today)', async () => {
      const s = sessionWithEmbedder([1, 0, 0]);
      try {
        s.createLibrary({ path: root });
        seedItems(join(root, 'catalog.sqlite3')); // items only — no embeddings stored
        const result = await s.search({ query: 'beach', limit: 10, offset: 0 });
        expect(result.total).toBe(1);
        expect(result.items.every((i) => itemCardSchema.safeParse(i).success)).toBe(true);
      } finally {
        s.dispose();
      }
    });

    it('degrades to exact FTS when query embedding throws (search never fails)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const s = createCatalogSession({
        coordinator: coordinator.coordinator,
        resolveMediaBinaries,
        resolveEmbedder: () => ({
          available: true,
          embed: async () => {
            throw new Error('embed boom');
          },
        }),
      });
      try {
        s.createLibrary({ path: root });
        const { exactId, semanticId } = seedSemanticCorpus(join(root, 'catalog.sqlite3'));

        const result = await s.search({ query: 'beach', limit: 10, offset: 0 });

        expect(result.items.map((i) => i.id)).toEqual([exactId]);
        expect(result.items.map((i) => i.id)).not.toContain(semanticId);
        expect(result.total).toBe(1);
      } finally {
        s.dispose();
        warn.mockRestore();
      }
    });

    it('paginates a globally-merged result set with no dup/skip and a page-independent total (#225)', async () => {
      const s = sessionWithEmbedder([1, 0, 0]);
      try {
        s.createLibrary({ path: root });
        const { exactIds, semanticIds } = seedPaginationCorpus(join(root, 'catalog.sqlite3'));
        const limit = 2;

        // Same query, three consecutive pages of a 5-result merged set (3 exact + 2 semantic).
        const p0 = await s.search({ query: 'familia', limit, offset: 0 });
        const p1 = await s.search({ query: 'familia', limit, offset: 2 });
        const p2 = await s.search({ query: 'familia', limit, offset: 4 });

        const ids0 = p0.items.map((i) => i.id);
        const ids1 = p1.items.map((i) => i.id);
        const ids2 = p2.items.map((i) => i.id);
        const all = [...ids0, ...ids1, ...ids2];

        // No dup (no overlap) AND no skip (no gap): the pages tile the full set exactly once.
        expect(new Set(all).size).toBe(all.length);
        expect(new Set(all)).toEqual(new Set([...exactIds, ...semanticIds]));
        expect(all.length).toBe(5);

        // total is page-independent — identical on every page — and counts the whole merged set.
        expect(p0.total).toBe(5);
        expect(p1.total).toBe(p0.total);
        expect(p2.total).toBe(p0.total);

        // AC-29: every exact match ranks AHEAD of any semantic-only match across the pages.
        const lastExact = Math.max(...exactIds.map((id) => all.indexOf(id)));
        const firstSemantic = Math.min(...semanticIds.map((id) => all.indexOf(id)));
        expect(lastExact).toBeLessThan(firstSemantic);

        // Contiguous slabs of `limit` (2 + 2 + 1).
        expect(ids0.length).toBe(2);
        expect(ids1.length).toBe(2);
        expect(ids2.length).toBe(1);
      } finally {
        s.dispose();
      }
    });

    it('exact-only fallback (UNAVAILABLE embedder) is byte-identical to FTS at every offset (#225)', async () => {
      // The default session injects no embedder → UNAVAILABLE; the seeded embeddings are ignored.
      session.createLibrary({ path: root });
      const catalogPath = join(root, 'catalog.sqlite3');
      seedPaginationCorpus(catalogPath);
      const db = openCatalog(catalogPath);
      const repo = createCatalogRepo(db);
      try {
        for (const offset of [0, 1, 2, 3]) {
          const got = await session.search({ query: 'familia', limit: 2, offset });
          const expected = repo.search({ query: 'familia', limit: 2, offset });
          expect(got.items.map((i) => i.id)).toEqual(expected.rows.map((r) => r.id));
          expect(got.total).toBe(expected.total);
        }
      } finally {
        db.close();
      }
    });

    it('does NOT embed a punctuation-only query even when the embedder is available (#225 guard)', async () => {
      const embedded: string[][] = [];
      const s = sessionWithEmbedder([1, 0, 0], (texts) => embedded.push([...texts]));
      try {
        s.createLibrary({ path: root });
        seedSemanticCorpus(join(root, 'catalog.sqlite3'));

        const result = await s.search({ query: '!!!', limit: 10, offset: 0 });

        // hasEmbeddableText is FALSE → the embedder is never invoked; pure exact FTS.
        expect(embedded).toEqual([]);
        expect(result.items).toEqual([]);
        expect(result.total).toBe(0);
      } finally {
        s.dispose();
      }
    });

    it('returns exact FTS when the embedder yields no query vector (#225 empty-embed guard)', async () => {
      const s = createCatalogSession({
        coordinator: coordinator.coordinator,
        resolveMediaBinaries,
        resolveEmbedder: () => ({ available: true, embed: async () => [] }),
      });
      try {
        s.createLibrary({ path: root });
        const { exactId, semanticId } = seedSemanticCorpus(join(root, 'catalog.sqlite3'));

        const result = await s.search({ query: 'beach', limit: 10, offset: 0 });

        // queryVector === undefined → early return before any semantic scan.
        expect(result.items.map((i) => i.id)).toEqual([exactId]);
        expect(result.items.map((i) => i.id)).not.toContain(semanticId);
        expect(result.total).toBe(1);
      } finally {
        s.dispose();
      }
    });

    // ── #431: type/date filters must constrain the SEMANTIC path too ──────────
    // A filter applied only to the exact page (and not to the hydrated semantic
    // hits inside the merge) would let a filtered-out memory ride back in as a
    // semantic-only extra. These pin the filter across BOTH paths of the merge.

    it('applies a media-type filter to semantic hits (a wrong-type extra is never surfaced) (#431)', async () => {
      const s = sessionWithEmbedder([1, 0, 0]);
      try {
        s.createLibrary({ path: root });
        const catalogPath = join(root, 'catalog.sqlite3');
        const db = openCatalog(catalogPath);
        const repo = createCatalogRepo(db);
        const embeddings = createEmbeddingsRepo(db);
        const src = repo.registerSource({ sourceKey: 'seed', type: 'folder', label: 'Seed' });
        // An exact "beach" match that IS a photo (survives a photo filter).
        const exactPhoto = repo.insertItem({
          mediaType: 'photo',
          contentHash: 'h-exact-photo',
          description: 'beach',
        });
        repo.addOccurrence({ itemId: exactPhoto, sourceId: src, sourceRef: 'e/1' });
        // A semantic-only AUDIO hit (no lexical overlap) — must be dropped by types:['photo'].
        const semanticAudio = repo.insertItem({
          mediaType: 'audio',
          contentHash: 'h-sem-audio',
          description: 'la playa',
        });
        repo.addOccurrence({ itemId: semanticAudio, sourceId: src, sourceRef: 's/1' });
        embeddings.upsertEmbedding(semanticAudio, EMBED_MODEL_ID, Float32Array.from([1, 0, 0]));
        db.close();

        const result = await s.search({ query: 'beach', limit: 10, offset: 0, types: ['photo'] });

        // Only the exact photo survives; the semantic audio hit is filtered out of the merge.
        expect(result.items.map((i) => i.id)).toEqual([exactPhoto]);
        expect(result.items.map((i) => i.id)).not.toContain(semanticAudio);
        // total reflects the TRUE filtered merged set, not the unfiltered one.
        expect(result.total).toBe(1);
      } finally {
        s.dispose();
      }
    });

    it('applies a day-range filter to semantic hits (an out-of-range extra is never surfaced) (#431)', async () => {
      const s = sessionWithEmbedder([1, 0, 0]);
      try {
        s.createLibrary({ path: root });
        const catalogPath = join(root, 'catalog.sqlite3');
        const db = openCatalog(catalogPath);
        const repo = createCatalogRepo(db);
        const embeddings = createEmbeddingsRepo(db);
        const src = repo.registerSource({ sourceKey: 'seed', type: 'folder', label: 'Seed' });
        // An exact "beach" match captured inside the range.
        const exactInRange = repo.insertItem({
          mediaType: 'photo',
          contentHash: 'h-exact-range',
          description: 'beach',
          captureDate: '2019-06-15T10:00:00.000Z',
        });
        repo.addOccurrence({ itemId: exactInRange, sourceId: src, sourceRef: 'e/1' });
        // A semantic-only hit captured OUTSIDE the range — must be dropped by the date filter.
        const semanticOutOfRange = repo.insertItem({
          mediaType: 'photo',
          contentHash: 'h-sem-range',
          description: 'la playa',
          captureDate: '2021-01-01T10:00:00.000Z',
        });
        repo.addOccurrence({ itemId: semanticOutOfRange, sourceId: src, sourceRef: 's/1' });
        embeddings.upsertEmbedding(semanticOutOfRange, EMBED_MODEL_ID, Float32Array.from([1, 0, 0]));
        db.close();

        const result = await s.search({
          query: 'beach',
          limit: 10,
          offset: 0,
          fromDate: '2019-01-01',
          toDate: '2019-12-31',
        });

        expect(result.items.map((i) => i.id)).toEqual([exactInRange]);
        expect(result.items.map((i) => i.id)).not.toContain(semanticOutOfRange);
        expect(result.total).toBe(1);
      } finally {
        s.dispose();
      }
    });
  });
});
