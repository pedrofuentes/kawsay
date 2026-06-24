import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database, { type Database as Db } from 'better-sqlite3';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';
import { createLibrary } from '../../electron/main/library/library-service';
import { type ThumbnailGenerator } from '../../electron/main/importers/ingest';
import type {
  CatalogRecord,
  Importer,
  ImporterDeps,
  ImportResult,
} from '../../electron/main/importers/types';
import {
  startIngestionJob,
  type IngestionContext,
} from '../../electron/main/importers/workers/ingestion-job';
import type {
  HostToWorkerMessage,
  IngestionJobSpec,
  WorkerPort,
  WorkerToHostMessage,
} from '../../electron/main/importers/ingestion/protocol';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

// ── Harness (mirrors ingest.test.ts so the worker drives the REAL engine) ─────

function freshCatalog(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

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

let seq = 0;
function record(originalPath: string): CatalogRecord {
  seq += 1;
  return {
    sourceType: 'folder',
    mediaType: 'photo',
    originalPath,
    mimeType: 'image/jpeg',
    date: { value: new Date('2020-05-01T10:00:00.000Z'), source: 'exif' },
    author: null,
    body: null,
    gps: null,
    durationSec: null,
    sourceRef: `ref-${seq}`,
    sourceMeta: {},
  };
}

function makeImporter(records: CatalogRecord[]): Importer {
  return {
    id: 'folder',
    displayName: 'Fake',
    async canHandle() {
      return true;
    },
    async *import(_inputPath, ctx): AsyncGenerator<CatalogRecord, ImportResult> {
      let recordCount = 0;
      for (const r of records) {
        if (ctx.signal.aborted) break;
        ctx.onProgress({ phase: 'emit', processed: recordCount, total: records.length });
        yield r;
        recordCount += 1;
      }
      return { recordCount, skipped: [] };
    },
  };
}

/** A fake WorkerPort: records what the job posts and lets the test deliver
 *  host→worker commands, with a small awaiter for the terminal message. */
function fakePort() {
  let onMsg: ((m: HostToWorkerMessage) => void) | undefined;
  const sent: WorkerToHostMessage[] = [];
  const waiters: { type: WorkerToHostMessage['type']; resolve: () => void }[] = [];
  const port: WorkerPort = {
    post: (m) => {
      sent.push(m);
      for (const w of waiters) if (w.type === m.type) w.resolve();
    },
    onMessage: (h) => {
      onMsg = h;
    },
  };
  return {
    port,
    sent,
    deliver: (m: HostToWorkerMessage) => onMsg?.(m),
    waitFor: (type: WorkerToHostMessage['type']) =>
      new Promise<void>((resolve) => {
        if (sent.some((m) => m.type === type)) resolve();
        else waiters.push({ type, resolve });
      }),
  };
}

describe('startIngestionJob (AC-9 worker-side engine drive)', () => {
  let db: Db;
  let repo: CatalogRepo;
  let libraryRoot: string;
  let close: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    libraryRoot = join(makeTmpDir('job'), 'lib');
    createLibrary({ root: libraryRoot, personName: 'Test' });
    db = freshCatalog();
    repo = createCatalogRepo(db);
    repo.registerSource({ id: 'src-1', sourceKey: 'src-1', type: 'folder', label: 'Folder' });
    close = vi.fn();
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

  function spec(): IngestionJobSpec {
    return {
      jobId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      sourceType: 'folder',
      inputPath: libraryRoot,
      libraryRoot,
      catalogPath: join(libraryRoot, 'catalog.sqlite3'),
      sourceId: 'src-1',
      workDir: join(libraryRoot, 'extract', 'src-1'),
    };
  }

  function context(importer: Importer, generateThumbnail: ThumbnailGenerator): IngestionContext {
    return { importer, db, repo, deps: makeDeps(), generateThumbnail, close };
  }

  it('announces ready, runs the engine off the message loop, streams progress, then done', async () => {
    const importer = makeImporter([record(write('a.jpg', 'AAA')), record(write('b.jpg', 'BBB'))]);
    const thumb: ThumbnailGenerator = async (req) => [
      { kind: 'thumbnail', path: join('derived', 'thumbnails', 'x', `${req.contentHash}.webp`) },
    ];
    const port = fakePort();

    startIngestionJob({ port: port.port, openContext: () => context(importer, thumb) });
    expect(port.sent).toEqual([{ type: 'ready' }]); // ready before any job

    port.deliver({ type: 'start', job: spec() });
    await port.waitFor('done');

    const progress = port.sent.filter((m) => m.type === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    const done = port.sent.at(-1);
    expect(done).toMatchObject({ type: 'done' });
    if (done?.type === 'done') {
      expect(done.summary.recordCount).toBe(2);
      expect(done.summary.cancelled).toBe(false);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 2 });
    expect(close).toHaveBeenCalledTimes(1); // context torn down
  });

  it('honours a port-driven cancel mid-import: partial summary, no throw (AC-9/AC-15)', async () => {
    const importer = makeImporter([record(write('a.jpg', 'AAA')), record(write('b.jpg', 'BBB'))]);
    const port = fakePort();
    // Cancel arrives WHILE the first record is being persisted (the engine sees
    // the abort at the next loop-top and stops with a partial, cancelled summary).
    const thumb: ThumbnailGenerator = async (req) => {
      port.deliver({ type: 'cancel' });
      return [{ kind: 'thumbnail', path: join('derived', 'thumbnails', 'x', `${req.contentHash}.webp`) }];
    };

    startIngestionJob({ port: port.port, openContext: () => context(importer, thumb) });
    port.deliver({ type: 'start', job: spec() });
    await port.waitFor('done');

    const done = port.sent.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.summary.recordCount).toBe(1);
      expect(done.summary.cancelled).toBe(true);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 1 });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reports an engine failure as an error message and still tears down', async () => {
    const importer = makeImporter([]);
    const thumb: ThumbnailGenerator = async () => [];
    const port = fakePort();

    startIngestionJob({
      port: port.port,
      openContext: () => context(importer, thumb),
      runIngestion: async () => {
        throw new Error('boom');
      },
    });
    port.deliver({ type: 'start', job: spec() });
    await port.waitFor('error');

    expect(port.sent.at(-1)).toEqual({ type: 'error', message: 'boom' });
    expect(close).toHaveBeenCalledTimes(1); // finally-close runs even on throw
  });

  it('ignores a second start (one job per worker)', async () => {
    const importer = makeImporter([record(write('a.jpg', 'AAA'))]);
    const thumb: ThumbnailGenerator = async () => [];
    const port = fakePort();

    startIngestionJob({ port: port.port, openContext: () => context(importer, thumb) });
    port.deliver({ type: 'start', job: spec() });
    port.deliver({ type: 'start', job: spec() });
    await port.waitFor('done');

    expect(port.sent.filter((m) => m.type === 'done')).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
