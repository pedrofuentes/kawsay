import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database, { type Database as Db } from 'better-sqlite3';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';
import { createLibrary } from '../../electron/main/library/library-service';
import { runIngestion, type ThumbnailGenerator } from '../../electron/main/importers/ingest';
import type {
  CatalogRecord,
  Importer,
  ImporterDeps,
  ImportResult,
} from '../../electron/main/importers/types';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

// ── Harness ─────────────────────────────────────────────────────────────────

function freshCatalog(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function count(db: Db, sql: string): number {
  return Number((db.prepare(sql).get() as { n: number }).n);
}

/** A deps double whose hashFile is a REAL content hash, so identical bytes
 *  dedupe exactly as production would, while ffmpeg/exif stay stubbed out. */
function makeDeps(overrides: Partial<ImporterDeps> = {}): ImporterDeps {
  return {
    fs: {
      readFile: async (p) => readFileSync(p),
      readDir: async () => [],
      stat: async (p) => {
        const bytes = readFileSync(p);
        return { size: bytes.length, mtimeMs: 0, isFile: () => true, isDirectory: () => false };
      },
      exists: async (p) => existsSync(p),
    },
    extractArchive: async () => [],
    readExif: async () => null,
    probeMedia: async () => ({ durationSec: null, width: null, height: null, mimeType: null }),
    hashFile: async (p) => createHash('sha256').update(readFileSync(p)).digest('hex'),
    ...overrides,
  };
}

/** An Importer double that yields the given records (honouring cancellation)
 *  and reports the given skips through ctx.onSkip — no real connector (C1–C5). */
function makeImporter(
  records: CatalogRecord[],
  options: { skips?: { ref: string; reason: string; code?: string }[] } = {},
): Importer {
  return {
    id: 'folder',
    displayName: 'Fake',
    async canHandle() {
      return true;
    },
    async *import(_inputPath, ctx): AsyncGenerator<CatalogRecord, ImportResult> {
      for (const skip of options.skips ?? []) ctx.onSkip(skip);
      let recordCount = 0;
      for (const record of records) {
        if (ctx.signal.aborted) break;
        ctx.onProgress({ phase: 'emit', processed: recordCount, total: records.length });
        yield record;
        recordCount += 1;
      }
      return { recordCount, skipped: options.skips ?? [] };
    },
  };
}

let nextHash = 0;
function record(partial: Partial<CatalogRecord> = {}): CatalogRecord {
  nextHash += 1;
  return {
    sourceType: 'folder',
    mediaType: 'photo',
    originalPath: null,
    mimeType: 'image/jpeg',
    date: { value: new Date('2020-05-01T10:00:00.000Z'), source: 'exif' },
    author: null,
    body: null,
    gps: null,
    durationSec: null,
    sourceRef: `ref-${nextHash}`,
    sourceMeta: {},
    ...partial,
  };
}

/** A thumbnail generator double that "writes" a rendition and reports it. */
function fakeThumbnailer(calls: { itemId: string; mediaType: string; sourcePath: string }[]) {
  const generator: ThumbnailGenerator = async (req) => {
    calls.push({ itemId: req.itemId, mediaType: req.mediaType, sourcePath: req.sourcePath });
    const kind = req.mediaType === 'video' ? 'poster' : 'thumbnail';
    const dir = kind === 'poster' ? 'posters' : 'thumbnails';
    const rel = join('derived', dir, req.contentHash.slice(0, 2), `${req.contentHash}.webp`);
    return [{ kind, path: rel, width: 480, height: 320, byteSize: 1234 }];
  };
  return generator;
}

describe('runIngestion (the off-thread ingestion orchestrator, ARCHITECTURE §5)', () => {
  let db: Db;
  let repo: CatalogRepo;
  let libraryRoot: string;

  beforeEach(() => {
    libraryRoot = join(makeTmpDir('ingest'), 'lib');
    createLibrary({ root: libraryRoot, personName: 'Test' });
    db = freshCatalog();
    repo = createCatalogRepo(db);
    // The caller (the IPC handler, in production) registers the source and hands
    // runIngestion its id; the orchestrator references it, never self-registers.
    repo.registerSource({ id: 'src-1', sourceKey: 'src-1', type: 'folder', label: 'Test source' });
  });
  afterEach(() => {
    db.close();
    removeTmpDir(libraryRoot);
  });

  function write(name: string, content: string): string {
    const abs = join(libraryRoot, name);
    writeFileSync(abs, content);
    return abs;
  }

  function run(importer: Importer, extra: Partial<Parameters<typeof runIngestion>[0]> = {}) {
    const thumbCalls: { itemId: string; mediaType: string; sourcePath: string }[] = [];
    const generateThumbnail = fakeThumbnailer(thumbCalls);
    const progress: { processed: number }[] = [];
    const promise = runIngestion({
      importer,
      inputPath: libraryRoot,
      db,
      repo,
      libraryRoot,
      sourceId: 'src-1',
      workDir: join(libraryRoot, 'extract', 'src-1'),
      deps: makeDeps(),
      generateThumbnail,
      signal: new AbortController().signal,
      onProgress: (p) => progress.push({ processed: p.processed }),
      ...extra,
    });
    return { promise, thumbCalls, progress };
  }

  it('ingests a folder photo as an in_place occurrence with a thumbnail', async () => {
    repo.registerSource({ sourceKey: 'k1', type: 'folder', label: 'Folder' });
    const file = write('photo.jpg', 'IMG-BYTES');
    const expectedHash = createHash('sha256').update('IMG-BYTES').digest('hex');
    const importer = makeImporter([
      record({ sourceType: 'folder', originalPath: file, sourceRef: 'photo.jpg', author: 'Mum' }),
    ]);

    const { promise, thumbCalls } = run(importer);
    const summary = await promise;

    expect(summary.recordCount).toBe(1);
    expect(summary.itemsTouched).toBe(1);
    expect(summary.occurrencesAdded).toBe(1);
    expect(summary.assetsAdded).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM items')).toBe(1);

    const item = db.prepare('SELECT * FROM items').get() as Record<string, unknown>;
    expect(item['content_hash']).toBe(expectedHash);
    expect(item['capture_date']).toBe('2020-05-01T10:00:00.000Z');
    expect(item['capture_date_src']).toBe('exif');

    const occ = db.prepare('SELECT * FROM item_occurrences').get() as Record<string, unknown>;
    expect(occ['original_kind']).toBe('in_place');
    expect(occ['original_path']).toBe(file);
    expect(occ['author']).toBe('Mum');

    const asset = db.prepare('SELECT * FROM item_assets').get() as Record<string, unknown>;
    expect(asset['kind']).toBe('thumbnail');
    expect(asset['path']).toBe(
      join('derived', 'thumbnails', expectedHash.slice(0, 2), `${expectedHash}.webp`),
    );
    expect(thumbCalls).toEqual([{ itemId: occ['item_id'], mediaType: 'photo', sourcePath: file }]);
  });

  it('stores an archive original content-addressed via putOriginal', async () => {
    const file = write('voice.opus', 'AUDIO-BYTES');
    const expectedHash = createHash('sha256').update('AUDIO-BYTES').digest('hex');
    const importer = makeImporter([
      record({
        sourceType: 'whatsapp',
        mediaType: 'video',
        mimeType: 'video/mp4',
        originalPath: file,
        sourceRef: 'media/voice.opus',
      }),
    ]);

    const { promise, thumbCalls } = run(importer);
    const summary = await promise;

    expect(summary.occurrencesAdded).toBe(1);
    const occ = db.prepare('SELECT * FROM item_occurrences').get() as Record<string, unknown>;
    expect(occ['original_kind']).toBe('content_addressed');
    expect(occ['original_path']).toBeNull();

    // The blob was copied ONCE into the content-addressed originals store.
    const blob = join(libraryRoot, 'originals', expectedHash.slice(0, 2), `${expectedHash}.opus`);
    expect(existsSync(blob)).toBe(true);
    expect(readFileSync(blob, 'utf8')).toBe('AUDIO-BYTES');
    // A video is rendered from its stored (content-addressed) bytes, not the source.
    expect(thumbCalls[0]?.sourcePath).toBe(blob);
    expect(thumbCalls[0]?.mediaType).toBe('video');
    const asset = db.prepare('SELECT * FROM item_assets').get() as Record<string, unknown>;
    expect(asset['kind']).toBe('poster');
  });

  it('dedupes identical bytes across two sources, keeping both occurrences and merging tokens (AC-7)', async () => {
    const a = write('alice.jpg', 'SAME-BYTES');
    const b = write('bob.jpg', 'SAME-BYTES');
    const importer = makeImporter([
      record({ sourceType: 'folder', originalPath: a, sourceRef: 'alice.jpg', author: 'Alice' }),
      record({ sourceType: 'whatsapp', originalPath: b, sourceRef: 'bob.jpg', author: 'Bob' }),
    ]);

    const summary = await run(importer).promise;

    expect(summary.recordCount).toBe(2);
    expect(count(db, 'SELECT COUNT(*) AS n FROM items')).toBe(1); // deduped
    expect(count(db, 'SELECT COUNT(*) AS n FROM item_occurrences')).toBe(2); // provenance kept
    const item = db.prepare('SELECT search_meta FROM items').get() as { search_meta: string };
    expect(item.search_meta).toContain('Alice');
    expect(item.search_meta).toContain('Bob');
  });

  it('re-import is idempotent: the same occurrence is not added twice', async () => {
    const file = write('photo.jpg', 'IDEMPOTENT');
    const make = () =>
      makeImporter([record({ sourceType: 'folder', originalPath: file, sourceRef: 'photo.jpg' })]);

    await run(make()).promise;
    const second = await run(make()).promise;

    expect(count(db, 'SELECT COUNT(*) AS n FROM item_occurrences')).toBe(1);
    expect(second.occurrencesAdded).toBe(0); // ON CONFLICT DO NOTHING
  });

  it('ingests a pure message with no original, no hash, no rendition', async () => {
    const importer = makeImporter([
      record({
        mediaType: 'message',
        mimeType: null,
        originalPath: null,
        body: 'hola',
        author: 'Papá',
        date: { value: new Date('2019-01-02T03:04:05.000Z'), source: 'message' },
        sourceRef: 'msg-1',
      }),
    ]);

    const { promise, thumbCalls } = run(importer);
    const summary = await promise;

    const occ = db.prepare('SELECT * FROM item_occurrences').get() as Record<string, unknown>;
    expect(occ['original_kind']).toBe('none');
    const item = db.prepare('SELECT * FROM items').get() as Record<string, unknown>;
    expect(item['content_hash']).toBeNull();
    expect(item['description']).toBe('hola');
    expect(summary.assetsAdded).toBe(0);
    expect(thumbCalls).toHaveLength(0);
  });

  it('reports skipped items without aborting the run (AC-15)', async () => {
    const file = write('ok.jpg', 'OK');
    const importer = makeImporter(
      [record({ sourceType: 'folder', originalPath: file, sourceRef: 'ok.jpg' })],
      { skips: [{ ref: 'broken.heic', reason: 'unreadable', code: 'E_DECODE' }] },
    );

    const summary = await run(importer).promise;

    expect(summary.skipped).toEqual([
      { ref: 'broken.heic', reason: 'unreadable', code: 'E_DECODE' },
    ]);
    expect(count(db, 'SELECT COUNT(*) AS n FROM items')).toBe(1); // the good one still landed
  });

  it('skips a record whose putOriginal throws and still completes the run (AC-15)', async () => {
    const bad = write('bad.mp4', 'BAD-BYTES');
    const good = write('good.mp4', 'GOOD-BYTES');
    const goodHash = createHash('sha256').update('GOOD-BYTES').digest('hex');
    // Two ARCHIVE-sourced records (sourceType !== 'folder') so both take the
    // content-addressed putOriginal retention path. The first record's hash is
    // one the originals store rejects, forcing putOriginal to throw mid-run; an
    // unguarded retention step would abort the whole import (bypassing AC-15).
    const importer = makeImporter([
      record({
        sourceType: 'whatsapp',
        mediaType: 'video',
        mimeType: 'video/mp4',
        originalPath: bad,
        sourceRef: 'media/bad.mp4',
      }),
      record({
        sourceType: 'whatsapp',
        mediaType: 'video',
        mimeType: 'video/mp4',
        originalPath: good,
        sourceRef: 'media/good.mp4',
      }),
    ]);
    const deps = makeDeps({
      hashFile: async (p) =>
        p.endsWith('bad.mp4')
          ? 'not-a-valid-content-hash'
          : createHash('sha256').update(readFileSync(p)).digest('hex'),
    });

    const summary = await run(importer, { deps }).promise;

    // The run completed (it did NOT throw): the bad record is reported skipped…
    expect(summary.skipped).toContainEqual({
      ref: 'media/bad.mp4',
      reason: expect.any(String),
      code: 'E_ORIGINAL_STORE',
    });
    // …and the following record still persisted.
    expect(count(db, 'SELECT COUNT(*) AS n FROM items')).toBe(1);
    const item = db.prepare('SELECT content_hash FROM items').get() as { content_hash: string };
    expect(item.content_hash).toBe(goodHash);
  });

  it('a thumbnail failure does not fail the item (counted as thumbnailFailures)', async () => {
    const file = write('photo.jpg', 'THUMBFAIL');
    const importer = makeImporter([
      record({ sourceType: 'folder', originalPath: file, sourceRef: 'photo.jpg' }),
    ]);
    const generateThumbnail: ThumbnailGenerator = async () => {
      throw new Error('ffmpeg blew up');
    };

    const summary = await run(importer, { generateThumbnail }).promise;

    expect(count(db, 'SELECT COUNT(*) AS n FROM items')).toBe(1);
    expect(summary.assetsAdded).toBe(0);
    expect(summary.thumbnailFailures).toBe(1);
  });

  it('honours a pre-aborted signal — emits nothing (AC-9 cancellation)', async () => {
    const file = write('photo.jpg', 'X');
    const importer = makeImporter([
      record({ sourceType: 'folder', originalPath: file, sourceRef: 'photo.jpg' }),
    ]);
    const controller = new AbortController();
    controller.abort();

    const summary = await run(importer, { signal: controller.signal }).promise;

    expect(summary.recordCount).toBe(0);
    expect(summary.cancelled).toBe(true);
    expect(count(db, 'SELECT COUNT(*) AS n FROM items')).toBe(0);
  });

  it('honours mid-stream cancellation — stops pulling further records', async () => {
    const f1 = write('a.jpg', 'AAA');
    const f2 = write('b.jpg', 'BBB');
    const importer = makeImporter([
      record({ sourceType: 'folder', originalPath: f1, sourceRef: 'a.jpg' }),
      record({ sourceType: 'folder', originalPath: f2, sourceRef: 'b.jpg' }),
    ]);
    const controller = new AbortController();
    const generateThumbnail: ThumbnailGenerator = async (req) => {
      controller.abort(); // cancel right after the first record is persisted
      return [
        { kind: 'thumbnail', path: join('derived', 'thumbnails', 'x', `${req.contentHash}.webp`) },
      ];
    };

    const summary = await run(importer, { signal: controller.signal, generateThumbnail }).promise;

    expect(summary.recordCount).toBe(1);
    expect(summary.cancelled).toBe(true);
    expect(count(db, 'SELECT COUNT(*) AS n FROM items')).toBe(1);
  });

  it('throttles progress using an injected clock', async () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      record({ mediaType: 'message', mimeType: null, sourceRef: `m-${i}` }),
    );
    const importer = makeImporter(records);
    const progress: number[] = [];
    const clock = 0;
    const now = vi.fn(() => clock);

    const summary = await run(importer, {
      onProgress: (p) => progress.push(p.processed),
      progressThrottleMs: 100,
      now,
    }).promise;

    // 5 records but the clock never advances past the throttle window, so the
    // per-record updates collapse — yet a final flush still reports completion.
    expect(summary.recordCount).toBe(5);
    expect(progress.length).toBeLessThan(5);
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress.at(-1)).toBe(5);
  });
});
